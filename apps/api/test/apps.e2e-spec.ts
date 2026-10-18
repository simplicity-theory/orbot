import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AppProgressView,
  RecordEvent,
  ServerDetailView,
  SupplyView,
  TaskDetailView,
} from '@orbot/shared';
import { vi } from 'vitest';
import { RuntimeRegistry } from '../src/runtime/runtime.registry.js';
import { ClaudeRuntime, type ClaudeClient } from '../src/runtime/claude.runtime.js';
import { SecretsService } from '../src/secrets/secrets.service.js';
import { AppsService } from '../src/servers/apps.service.js';
import { SshClient, type SshTarget } from '../src/servers/ssh.client.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

const run = promisify(execFile);

type Block = Record<string, unknown>;
const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});

class FakeClaude {
  readonly requests: unknown[] = [];
  constructor(private readonly turns: Block[][]) {}
  readonly beta = {
    messages: {
      create: async (params: unknown) => {
        this.requests.push(params);
        return {
          content: this.turns.shift() ?? [],
          stop_reason: 'tool_use',
          stop_details: null,
          usage: { output_tokens: 100 },
        };
      },
      parse: async () => ({ parsed_output: null, stop_reason: 'end_turn', content: [] }),
    },
  };
}

const KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAgpukeygpukey\n-----END OPENSSH PRIVATE KEY-----';
const HOST_KEY =
  '127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGpu8kQ2mN7pL4vR9tY3wB6cF1hJ5gD0sAx9PqZz';
const handover = {
  state: 'Checked.',
  nextSteps: [],
  triedAndFailed: [],
  openProblems: [],
  flagsForSuccessor: [],
};

/**
 * A GPU server, simulated at the SSH boundary: it answers the commands ORBOT sends the way
 * Ubuntu with systemd would, and an install moves on when the test says so.
 */
class FakeGpuServer {
  readonly runs: { user: string; key: string; command: string; stdin: Buffer | undefined }[] = [];
  state = 'missing';
  active = false;
  log = '';
  bundle: Buffer | null = null;
  envFile = '';
  workspaceKey = '';

  /** The public half of a private key, as sshd would check it. */
  private async publicOf(privateKey: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fake-sshd-'));
    try {
      await writeFile(join(dir, 'k'), privateKey, { mode: 0o600 });
      const { stdout } = await run('ssh-keygen', ['-y', '-f', join(dir, 'k')]);
      return stdout.trim();
    } catch {
      return '';
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async answer(target: SshTarget, key: string, command: string, stdin?: Buffer) {
    this.runs.push({ user: target.user, key, command, stdin });
    const ok = (output: string) => ({ exitCode: 0, output });
    if (target.user === 'orbot-dev') {
      const pub = await this.publicOf(key);
      return pub && this.workspaceKey.startsWith(pub)
        ? ok(command === 'echo orbot-ok' ? 'orbot-ok\n' : `ran as orbot-dev: ${command}\n`)
        : { exitCode: 255, output: 'Permission denied (publickey).' };
    }
    if (command.startsWith('echo orbot-ok')) {
      return ok(
        'orbot-ok\nos=Ubuntu 24.04.1 LTS\ngpu=NVIDIA GeForce RTX 3090, 24576 MiB, 550.120\ndocker=not installed\nsudo=passwordless\nrsync=yes\n',
      );
    }
    if (command.includes('tar -xf - --no-same-owner -C /opt/orbot')) {
      this.bundle = stdin ?? null;
      return ok('');
    }
    if (command.includes("cat > /etc/orbot/apps/vllm.env'")) {
      this.envFile = stdin?.toString('utf8') ?? '';
      return ok('');
    }
    if (command.includes('systemd-run --unit=orbot-app-vllm-')) {
      this.state = 'running start';
      this.active = true;
      this.log = '';
      return ok('Running as unit: orbot-app-vllm-install.service\n');
    }
    if (command.includes('cat /var/lib/orbot/apps/vllm/state')) {
      return ok(
        `${this.state}\n---orbot---\n${this.active ? 'active' : 'inactive'}\n---orbot---\n${this.log}\n`,
      );
    }
    if (command.includes('/opt/orbot/apps/vllm/status.sh')) {
      return ok(
        'service=active\nhealth=ok\nmodels=qwen3-14b\ngpu=NVIDIA GeForce RTX 3090, 20112 MiB, 24576 MiB, 0 %\n',
      );
    }
    if (command.startsWith('sudo -n bash -s  # deploy/server/workspace.sh')) {
      const text = stdin?.toString('utf8') ?? '';
      this.workspaceKey = text.match(/PUBLIC_KEY='([^']+)'/)?.[1] ?? '';
      return ok('created user orbot-dev\nrsync=yes\norbot-workspace-ok\n');
    }
    if (command.startsWith('sudo -n systemctl stop')) return ok('');
    return ok(`ran: ${command}\n`);
  }
}

describe('Apps on servers: install vLLM from deploy/apps and serve a model to the depot', () => {
  let t: TestApp;
  let gpu: FakeGpuServer;
  let api: HttpServer;
  let apiPort: number;
  let serverId: string;
  let repoId: string;
  let apiKey = '';

  beforeAll(async () => {
    t = await startTestApp();
    gpu = new FakeGpuServer();
    const ssh = t.app.get(SshClient);
    vi.spyOn(ssh, 'scan').mockResolvedValue([HOST_KEY]);
    vi.spyOn(ssh, 'fingerprints').mockResolvedValue(['256 SHA256:gpuprint 127.0.0.1 (ED25519)']);
    vi.spyOn(ssh, 'run').mockImplementation(async (target, key, command, opts) =>
      gpu.answer(target, key, command, opts.stdin),
    );
    // The OpenAI-compatible API vLLM serves, with the key the install generated.
    api = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        res.writeHead(401).end('{"error":"Unauthorized"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-14b', object: 'model' }] }));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiPort = (api.address() as AddressInfo).port;
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    await t.agent.post('/api/supply/credentials').send({ name: 'gpu-key', value: KEY }).expect(201);
  });
  afterAll(async () => {
    api.close();
    await t.close();
  });

  const detail = async () =>
    (await t.agent.get(`/api/supply/servers/${serverId}`).expect(200)).body as ServerDetailView;

  it('connecting a server records what it is: OS, GPU, sudo', async () => {
    const s: SupplyView = (
      await t.agent
        .post('/api/supply/servers')
        .send({
          name: 'gpu1',
          tier: 'dev',
          host: '127.0.0.1',
          user: 'admin',
          credentialName: 'gpu-key',
        })
        .expect(201)
    ).body;
    serverId = s.id;
    expect(s.spec).toMatchObject({
      kind: 'environment',
      server: {
        rsync: true,
        workspace: null,
        apps: [],
        facts: {
          os: 'Ubuntu 24.04.1 LTS',
          gpu: 'NVIDIA GeForce RTX 3090, 24576 MiB, 550.120',
          sudo: 'passwordless',
        },
      },
    });
    const check = await t.agent.post(`/api/supply/servers/${serverId}/check`).expect(200);
    expect(check.body).toEqual({
      ok: true,
      output: 'Ubuntu 24.04.1 LTS · NVIDIA GeForce RTX 3090, 24576 MiB, 550.120',
    });
  });

  it('the server page lists the apps in deploy/apps, vLLM among them', async () => {
    const d = await detail();
    const vllm = d.catalog.find((a) => a.id === 'vllm')!;
    expect(vllm.name).toBe('vLLM');
    expect(vllm.settings.map((x) => x.key)).toEqual(
      expect.arrayContaining(['MODEL', 'SERVED_NAME', 'PORT', 'MAX_MODEL_LEN']),
    );
    expect(vllm.secrets.find((x) => x.key === 'VLLM_API_KEY')).toMatchObject({ generate: true });
    expect(vllm.provides).toMatchObject({ kind: 'model', protocol: 'openai' });
  });

  it('settings are checked against the manifest before anything runs on the server', async () => {
    const before = gpu.runs.length;
    const bad = async (body: Record<string, unknown>) =>
      (await t.agent.post(`/api/supply/servers/${serverId}/apps`).send(body).expect(400)).body.error
        .message;
    expect(await bad({ app: 'vllm', settings: { PORT: 80 } })).toBe(
      'Port: must be between 1024 and 65535.',
    );
    expect(await bad({ app: 'vllm', settings: { MODEL: "x'; rm -rf /" } })).toContain(
      'Model: may use letters, digits',
    );
    expect(await bad({ app: 'vllm', settings: { NOPE: 1 } })).toBe('vLLM has no setting NOPE.');
    expect(await bad({ app: 'vllm', credentials: { HF_TOKEN: 'missing-token' } })).toBe(
      'No credential called "missing-token" is stored.',
    );
    expect(
      (await t.agent.post(`/api/supply/servers/${serverId}/apps`).send({ app: 'nope' }).expect(404))
        .body.error.message,
    ).toBe('There is no app called "nope" in deploy/apps.');
    expect(gpu.runs.length).toBe(before);
  });

  it('installing copies the app over, writes its settings root-only, and starts it under systemd-run', async () => {
    const r = await t.agent
      .post(`/api/supply/servers/${serverId}/apps`)
      .send({ app: 'vllm', settings: { PORT: apiPort, MAX_MODEL_LEN: 16384 } })
      .expect(201);
    const app = (
      r.body as SupplyView & { spec: { server: { apps: { id: string; status: string }[] } } }
    ).spec.server.apps[0]!;
    expect(app.status).toBe('installing');
    await settled(t.app);

    // The bundle is deploy/lib and deploy/apps/vllm, scripts executable.
    const files = await new Promise<string>((resolve, reject) => {
      const child = execFile('tar', ['-tvf', '-'], (err, out) =>
        err ? reject(err) : resolve(out),
      );
      child.stdin!.end(gpu.bundle);
    });
    expect(files).toMatch(/-rwx.* apps\/vllm\/install\.sh/);
    expect(files).toContain('lib/common.sh');
    expect(files).not.toContain('apps/other');

    // Settings as KEY='value'; the API key is generated, stored by name and only here in clear.
    apiKey = await t.app.get(SecretsService).reveal('gpu1.vllm.vllm_api_key');
    expect(apiKey.length).toBeGreaterThan(20);
    expect(gpu.envFile).toContain(`PORT='${apiPort}'`);
    expect(gpu.envFile).toContain("MAX_MODEL_LEN='16384'");
    expect(gpu.envFile).toContain("MODEL='Qwen/Qwen3-14B-AWQ'");
    expect(gpu.envFile).toContain(`VLLM_API_KEY='${apiKey}'`);
    expect(gpu.envFile).toContain("HF_TOKEN=''");
    const launch = gpu.runs.find((x) => x.command.includes('systemd-run'))!;
    expect(launch.command).toContain('--unit=orbot-app-vllm-install');
    expect(launch.command).toContain('/bin/bash /opt/orbot/apps/vllm/install.sh');
    expect(gpu.runs.every((x) => !x.command.includes(apiKey))).toBe(true);

    // The depot lists the key as a credential, by name.
    const supply: SupplyView[] = (await t.agent.get('/api/supply').expect(200)).body;
    expect(supply.find((s) => s.name === 'gpu1.vllm.vllm_api_key')?.spec.kind).toBe('credential');
  });

  it('ORBOT follows the install step by step, shows its log redacted, then adds the model to the depot', async () => {
    const apps = t.app.get(AppsService);
    const appId = appOf(await detail()).id;
    gpu.state = 'running pull vllm/vllm-openai:latest';
    gpu.log = `==> 12:00:01 pull vllm/vllm-openai:latest\nwrote key ${apiKey}`;
    await apps.poll(serverId, appId);
    expect(appOf(await detail())).toMatchObject({
      status: 'installing',
      message: 'pull vllm/vllm-openai:latest',
    });

    const p: AppProgressView = (
      await t.agent.get(`/api/supply/servers/${serverId}/apps/${appId}/progress`).expect(200)
    ).body;
    expect(p).toMatchObject({ state: 'running pull vllm/vllm-openai:latest', active: true });
    expect(p.log).toContain('==> 12:00:01 pull');
    expect(p.log).not.toContain(apiKey);

    gpu.state = 'done';
    gpu.active = false;
    gpu.log += '\n==> vLLM serves qwen3-14b';
    await apps.poll(serverId, appId);
    const d = await detail();
    const app = appOf(d);
    expect(app).toMatchObject({
      status: 'running',
      message: null,
      report: { service: 'active', health: 'ok', models: 'qwen3-14b' },
    });
    const model = (await t.agent.get('/api/supply').expect(200)).body.find(
      (s: SupplyView) => s.id === app.provides[0],
    ) as SupplyView;
    expect(model).toMatchObject({
      name: 'qwen3-14b on gpu1',
      connected: true,
      spec: {
        kind: 'model',
        protocol: 'openai',
        baseUrl: `http://127.0.0.1:${apiPort}/v1`,
        model: 'qwen3-14b',
        credentialName: 'gpu1.vllm.vllm_api_key',
        contextWindow: 16384,
        hostedOn: { supplyId: serverId, appId },
      },
    });
    const events = d.events.filter((e) => e.kind === 'app.install') as RecordEvent<'app.install'>[];
    expect(events.map((e) => e.body.status)).toEqual(['started', 'installed']);
    expect(events.map((e) => e.body.app)).toEqual(['vLLM', 'vLLM']);
    expect(events[1]!.body.log).toContain('vLLM serves qwen3-14b');
    expect(JSON.stringify(d)).not.toContain(apiKey);

    const check = await t.agent.post(`/api/supply/models/${model.id}/check`).expect(200);
    expect(check.body).toEqual({
      ok: true,
      models: ['qwen3-14b'],
      message: `qwen3-14b answers at http://127.0.0.1:${apiPort}/v1.`,
    });
    expect(JSON.stringify(check.body)).not.toContain(apiKey);
  });

  it('a failed step is recorded with why; a second install while one runs is refused', async () => {
    const apps = t.app.get(AppsService);
    await t.agent
      .post(`/api/supply/servers/${serverId}/apps`)
      .send({ app: 'vllm', settings: { PORT: apiPort } })
      .expect(201);
    await settled(t.app);
    expect(
      (await t.agent.post(`/api/supply/servers/${serverId}/apps`).send({ app: 'vllm' }).expect(409))
        .body.error.message,
    ).toBe('vLLM is already installing on gpu1.');
    // Reinstalling keeps the generated key.
    expect(gpu.envFile).toContain(`VLLM_API_KEY='${apiKey}'`);
    gpu.state =
      "failed check the GPU: no working NVIDIA driver (nvidia-smi). Install one with 'sudo ubuntu-drivers install', reboot, then install again";
    gpu.active = false;
    await apps.poll(serverId, appOf(await detail()).id);
    expect(appOf(await detail())).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('check the GPU: no working NVIDIA driver'),
    });
  });

  it('bots lose the admin login on a server that runs apps; with the bot workspace, dev_run runs as orbot-dev', async () => {
    const fx = await makeUnitWithBot(t.app, {
      name: 'Gpu',
      prefix: 'G',
      supplyIds: [repoId, serverId],
    });
    const runTask = async (turns: Block[][]) => {
      const fake = new FakeClaude(turns);
      t.app
        .get(RuntimeRegistry)
        .register(new ClaudeRuntime(fake as unknown as ClaudeClient, { model: 'claude-opus-5-5' }));
      await t.agent
        .put(`/api/bots/${fx.bot.entityId}/runtime`)
        .send({ runtime: 'claude', reason: 'Real work' })
        .expect(200);
      const task = (
        await t.agent
          .post('/api/tasks')
          .send({
            unitId: fx.unit.entityId,
            botId: fx.bot.entityId,
            title: 'Train it',
            repoSupplyId: repoId,
          })
          .expect(201)
      ).body;
      await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
      await settled(t.app);
      const d: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
      return { d, sent: JSON.stringify(fake.requests) };
    };
    vi.spyOn(t.app.get(SshClient), 'sync').mockResolvedValue({ exitCode: 0, output: '' });

    const before = await runTask([
      [toolUse('z', 'list_servers', {})],
      [toolUse('a', 'server_run', { server: 'gpu1', command: 'docker stop orbot-vllm' })],
      [toolUse('b', 'dev_run', { server: '', command: 'python train.py' })],
      [toolUse('c', 'write_handover', handover)],
      [toolUse('d', 'done', { summary: 'ok' })],
    ]);
    expect(before.sent).toContain(
      'gpu1 runs apps (vLLM): bots log in as its admin only inside a production deploy you approved',
    );
    expect(before.sent).toContain("Set up the bot workspace on gpu1's page");
    expect(gpu.runs.some((x) => x.command.includes('docker stop orbot-vllm'))).toBe(false);
    expect(before.sent).toContain('GPU: NVIDIA GeForce RTX 3090, 24576 MiB, 550.120');
    expect(before.sent).toContain('dev_run works as admin');
    expect(before.sent).toContain(
      'Runs apps (vLLM): server_run and server_upload only inside an approved deploy',
    );

    const ws = await t.agent.post(`/api/supply/servers/${serverId}/workspace`);
    expect(ws.status).toBe(200);
    expect(ws.body.spec.server.workspace).toEqual({
      user: 'orbot-dev',
      credentialName: 'gpu1.orbot-dev.key',
    });
    expect(gpu.workspaceKey).toMatch(/^ssh-ed25519 /);
    expect(JSON.stringify(ws.body)).not.toContain('PRIVATE KEY');

    const after = await runTask([
      [toolUse('a', 'dev_run', { server: '', command: 'python train.py' })],
      [toolUse('b', 'write_handover', handover)],
      [toolUse('c', 'done', { summary: 'ok' })],
    ]);
    expect(after.d.task.status).toBe('done');
    const last = gpu.runs.at(-1)!;
    expect(last.user).toBe('orbot-dev');
    expect(last.command).toMatch(/^cd orbot-dev\/app\/[a-z]+-\d+ && python train.py$/);
    const cmd = after.d.events.find(
      (e) => e.kind === 'server.command',
    ) as RecordEvent<'server.command'>;
    expect(cmd.body.command).toMatch(/^\[orbot-dev:orbot-dev\/app\/[a-z]+-\d+\] python train.py$/);
  });

  it('removing an app keeps its model in the depot, marked not connected', async () => {
    const apps = t.app.get(AppsService);
    const app = appOf(await detail());
    await t.agent.post(`/api/supply/servers/${serverId}/apps/${app.id}/uninstall`).expect(200);
    await settled(t.app);
    expect(gpu.runs.at(-1)!.command).toContain('/bin/bash /opt/orbot/apps/vllm/uninstall.sh');
    gpu.state = 'removed';
    gpu.active = false;
    await apps.poll(serverId, app.id);
    expect(appOf(await detail()).status).toBe('removed');
    const model = (await t.agent.get('/api/supply').expect(200)).body.find(
      (s: SupplyView) => s.id === app.provides[0],
    );
    expect(model.connected).toBe(false);
  });
});

function appOf(d: ServerDetailView) {
  if (d.supply.spec.kind !== 'environment' || !d.supply.spec.server)
    throw new Error('not a server');
  return d.supply.spec.server.apps[0]!;
}
