import type { RecordEvent, SupplyView, TaskDetailView } from '@orbot/shared';
import { vi } from 'vitest';
import { git } from '../src/common/git.js';
import { RecordService } from '../src/record/record.service.js';
import { ClaudeRuntime, type ClaudeClient } from '../src/runtime/claude.runtime.js';
import { RuntimeRegistry } from '../src/runtime/runtime.registry.js';
import { SshClient, type SshTarget } from '../src/servers/ssh.client.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

type Block = Record<string, unknown>;
const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});

/** Replays a fixed conversation; keeps every request so the test can see what the model saw. */
class FakeClaude {
  readonly requests: unknown[] = [];
  constructor(private readonly turns: Block[][]) {}
  readonly beta = {
    messages: {
      create: async (params: unknown) => {
        this.requests.push(params);
        const content = this.turns.shift() ?? [];
        return {
          content,
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
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAfakekeyfakekey\n-----END OPENSSH PRIVATE KEY-----';
// A real-looking host key: high-entropy, yet public, so it must survive redaction on the record.
const HOST_KEY =
  'web1.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBx8kQ2mN7pL4vR9tY3wB6cF1hJ5gD0sAx9PqZz';
const handover = {
  state: 'Server set up.',
  nextSteps: [],
  triedAndFailed: [],
  openProblems: [],
  flagsForSuccessor: ['nginx serves /srv/app.'],
};

describe('Servers: bots log in over SSH to the servers their unit holds', () => {
  let t: TestApp;
  let ssh: SshClient;
  let repoId: string;
  const runs: { target: SshTarget; key: string; command: string; stdinBytes: number }[] = [];

  const server = (body: Record<string, unknown>) =>
    t.agent.post('/api/supply/servers').send({
      name: 'web1',
      tier: 'staging',
      host: 'web1.test',
      user: 'deploy',
      credentialName: 'web1-key',
      ...body,
    });

  const runTask = async (
    unitId: string,
    botId: string,
    turns: Block[][],
    extra: Record<string, unknown> = {},
  ) => {
    const fake = new FakeClaude(turns);
    t.app
      .get(RuntimeRegistry)
      .register(new ClaudeRuntime(fake as unknown as ClaudeClient, { model: 'claude-opus-5-5' }));
    await t.agent
      .put(`/api/bots/${botId}/runtime`)
      .send({ runtime: 'claude', reason: 'Real work' })
      .expect(200);
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title: 'Set up the web server', repoSupplyId: repoId, ...extra })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    const d: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
    return { d, fake };
  };

  beforeAll(async () => {
    t = await startTestApp();
    ssh = t.app.get(SshClient);
    vi.spyOn(ssh, 'scan').mockImplementation(async (host) =>
      host === 'web1.test' || host === 'prod1.test' ? [HOST_KEY] : [],
    );
    vi.spyOn(ssh, 'fingerprints').mockResolvedValue(['256 SHA256:fakeprint web1.test (ED25519)']);
    vi.spyOn(ssh, 'run').mockImplementation(async (target, key, command, opts) => {
      let stdinBytes = 0;
      if (opts.stdin) stdinBytes = opts.stdin.length;
      runs.push({ target, key, command, stdinBytes });
      if (target.user === 'nobody')
        return { exitCode: 255, output: 'Permission denied (publickey).' };
      if (command === 'echo orbot-ok') return { exitCode: 0, output: 'orbot-ok\n' };
      if (command.startsWith('cat ~/.ssh')) return { exitCode: 0, output: `here it is:\n${key}\n` };
      return { exitCode: 0, output: `ran: ${command}\n` };
    });
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    await t.agent
      .post('/api/supply/credentials')
      .send({ name: 'web1-key', value: KEY })
      .expect(201);
  });
  afterAll(() => t.close());

  it('connecting pins the host key and proves the login; the key never comes back', async () => {
    expect((await server({ credentialName: 'nope' }).expect(400)).body.error.message).toBe(
      'No credential called "nope" is stored.',
    );
    expect((await server({ host: 'gone.test' }).expect(400)).body.error.message).toBe(
      'Could not reach SSH on gone.test:22.',
    );
    expect((await server({ user: 'nobody' }).expect(400)).body.error.message).toContain(
      'could not log in as nobody@web1.test: Permission denied (publickey).',
    );
    const r = await server({ url: 'https://web1.test' }).expect(201);
    const s: SupplyView = r.body;
    expect(s.spec).toMatchObject({
      kind: 'environment',
      details: { tier: 'staging' },
      server: {
        host: 'web1.test',
        port: 22,
        user: 'deploy',
        credentialName: 'web1-key',
        hostKeys: [HOST_KEY],
        url: 'https://web1.test',
      },
    });
    expect(JSON.stringify(r.body)).not.toContain('fakekey');
    expect(runs.at(-1)).toMatchObject({ key: KEY, command: 'echo orbot-ok' });
    expect(runs.at(-1)!.target.hostKeys).toEqual([HOST_KEY]);

    const check = await t.agent.post(`/api/supply/servers/${s.id}/check`).expect(200);
    expect(check.body.ok).toBe(true);
  });

  it('a bot in a unit that holds the server runs commands on it and copies its work there; all on the record, key never shown', async () => {
    const web1 = ((await t.agent.get('/api/supply').expect(200)).body as SupplyView[]).find(
      (x) => x.name === 'web1',
    )!;
    const fx = await makeUnitWithBot(t.app, {
      name: 'Logistics',
      prefix: 'L',
      role: 'DevOps',
      supplyIds: [repoId, web1.id],
    });
    const { d, fake } = await runTask(fx.unit.entityId, fx.bot.entityId, [
      [toolUse('a', 'list_servers', {})],
      [toolUse('b', 'server_run', { server: 'web1', command: 'sudo -n apt-get install -y nginx' })],
      [toolUse('c', 'server_run', { server: 'web1', command: 'cat ~/.ssh/id_ed25519' })],
      [toolUse('d', 'server_run', { server: 'db9', command: 'uptime' })],
      [
        toolUse('e', 'write_file', { path: 'index.html', content: '<h1>hi</h1>\n' }),
        toolUse('f', 'commit', { message: 'Landing page' }),
      ],
      [toolUse('g', 'server_upload', { server: 'web1', path: '/srv/app' })],
      [toolUse('h', 'write_handover', handover)],
      [toolUse('i', 'done', { summary: 'nginx up, app copied.' })],
    ]);
    expect(d.task.status).toBe('done');

    const sent = JSON.stringify(fake.requests);
    expect(sent).toContain('web1 (staging): deploy@web1.test, https://web1.test');
    expect(sent).toContain('exit 0\\nran: sudo -n apt-get install -y nginx');
    expect(sent).toContain('Your unit holds no server called \\"db9\\". It holds: web1.');
    expect(sent).not.toContain('fakekey');

    const cmds = d.events.filter(
      (e) => e.kind === 'server.command',
    ) as RecordEvent<'server.command'>[];
    expect(cmds.map((e) => e.body.command)).toEqual([
      'sudo -n apt-get install -y nginx',
      'cat ~/.ssh/id_ed25519',
      expect.stringMatching(/^upload [0-9a-f]{10} to \/srv\/app$/),
    ]);
    expect(cmds[0]!.body).toMatchObject({ server: 'web1', exitCode: 0, supplyId: web1.id });
    // The key, echoed back by the server, is masked on the record.
    expect(JSON.stringify(cmds[1]!.body)).not.toContain('fakekey');
    expect(d.events.some((e) => e.kind === 'credential.used')).toBe(true);

    const head = await git(d.task.workspace!.path, ['rev-parse', 'HEAD']);
    const upload = runs.find((r) => r.command === 'mkdir -p /srv/app && tar -xf - -C /srv/app')!;
    expect(upload.stdinBytes).toBeGreaterThan(0);
    const deployment = d.events.find((e) => e.kind === 'deployment') as RecordEvent<'deployment'>;
    expect(deployment.body).toEqual({ environment: 'web1', ref: 'deploy/web1', commit: head });
  });

  it('a unit that does not hold the server cannot reach it', async () => {
    const fx = await makeUnitWithBot(t.app, { name: 'Engineers', supplyIds: [repoId] });
    const before = runs.length;
    const { fake } = await runTask(fx.unit.entityId, fx.bot.entityId, [
      [toolUse('a', 'server_run', { server: 'web1', command: 'uptime' })],
      [toolUse('b', 'write_handover', handover)],
      [toolUse('c', 'done', { summary: 'ok' })],
    ]);
    expect(JSON.stringify(fake.requests)).toContain('It holds none');
    expect(runs.length).toBe(before);
  });

  it('a production server is reached only inside a production deploy the Commander approved', async () => {
    const prod = (
      await server({ name: 'prod1', tier: 'production', host: 'prod1.test' }).expect(201)
    ).body as SupplyView;
    const fx = await makeUnitWithBot(t.app, {
      name: 'Release',
      prefix: 'R',
      role: 'DevOps',
      supplyIds: [repoId, prod.id],
    });
    const before = runs.length;
    const { fake } = await runTask(fx.unit.entityId, fx.bot.entityId, [
      [toolUse('a', 'server_run', { server: 'prod1', command: 'systemctl restart app' })],
      [toolUse('b', 'write_handover', handover)],
      [toolUse('c', 'done', { summary: 'ok' })],
    ]);
    expect(JSON.stringify(fake.requests)).toContain(
      'Refused: prod1 is a production server: bots reach it only inside a production deploy you approved.',
    );
    expect(runs.length).toBe(before);
    const refusals = await t.app
      .get(RecordService)
      .listEvents({ kinds: ['policy.check'], unitId: fx.unit.entityId, limit: 50 });
    expect(refusals.map((e) => (e.body as { reason: string }).reason)).toContain(
      'Production servers: prod1 is a production server: bots reach it only inside a production deploy you approved',
    );
  });

  it('recon gets no server commands', async () => {
    const { RECON_TOOLS } = await import('../src/runtime/claude-common.js');
    const names = RECON_TOOLS.map((x) => x.name);
    expect(names).toContain('list_servers');
    expect(names).not.toContain('server_run');
    expect(names).not.toContain('server_upload');
  });
});
