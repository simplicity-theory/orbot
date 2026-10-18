import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  actorRef,
  type ConnectServerRequest,
  type UpdateEnvironmentRequest,
  type PolicyRule,
  type Principal,
  type RecordEventRefs,
  type RecordVersion,
  type ServerAccess,
  type ServerInfo,
  type ServerResult,
  type SupplyBody,
  type TaskBody,
} from '@orbot/shared';
import type { z } from 'zod';
import { git } from '../common/git.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { OFFICER_SECRET_PREFIX } from '../officers/officers.service.js';
import { PolicyService } from '../policy/policy.service.js';
import type { WriteContext } from '../record/record.service.js';
import { RecordService } from '../record/record.service.js';
import { RedactionService } from '../redaction/redaction.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { SupplyService } from '../supply/supply.service.js';
import { SshClient, type SshTarget } from './ssh.client.js';

export type Server = RecordVersion<SupplyBody> & {
  body: SupplyBody & { spec: { kind: 'environment'; server: ServerAccess } };
};

/** How long one command may run on a server before it is stopped. */
const COMMAND_TIMEOUT_MS = 15 * 60_000;
/** Output kept on the record per command (the tail). */
const RECORD_OUTPUT = 8_000;
/** Output shown back to the bot per command (the tail). */
const BOT_OUTPUT = 20_000;

const run = promisify(execFile);

/** The committed tree at HEAD, as a tar archive. */
async function gitArchive(cwd: string): Promise<Buffer> {
  const r = await run('git', ['archive', '--format=tar', 'HEAD'], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
  });
  return r.stdout;
}

export const tail = (s: string, n: number) => (s.length > n ? `[…]\n${s.slice(-n)}` : s);

/** `key=value` lines (as deploy/server/facts.sh and an app's status.sh print them). */
export function parseKv(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && /^[a-z][a-z0-9_-]*$/.test(line.slice(0, i)))
      out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/** A short, safe name for credentials and folders. */
export const slug = (x: string) =>
  x
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '') || 'x';

/** The user bots' dev work runs as, once the bot workspace is set up. */
export const WORKSPACE_USER = 'orbot-dev';

/**
 * Servers bots log in to. A server is an environment with SSH access: issuing it to a unit
 * lets that unit's bots run commands on it and copy their work there, the way they see fit.
 * The key is used by name (the bot never sees it), the host key is pinned, and every command
 * and its redacted output is on the record. Production servers are reached only inside a
 * production deploy the Commander approved.
 */
@Injectable()
export class ServersService implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly secrets: SecretsService,
    private readonly supply: SupplyService,
    private readonly redaction: RedactionService,
    private readonly policy: PolicyService,
    readonly ssh: SshClient,
  ) {}

  onModuleInit() {
    this.policy.addRule(this.productionRule());
  }

  private productionRule(): PolicyRule {
    return {
      name: 'Production servers',
      evaluate: async (req) => {
        if (req.action !== 'server.run') return null;
        const production = req.details?.['tier'] === 'production';
        // Apps run on it: the admin login could stop or change them, so it is production-only.
        const hostsApps =
          req.details?.['hostsApps'] === true && req.details['asWorkspace'] !== true;
        if (!production && !hostsApps) return null;
        const task = req.taskId ? await this.record.getActive('task', req.taskId) : null;
        if (task?.body.kind === 'deploy' && task.body.approval?.status === 'approved') return null;
        const server = String(req.details?.['server']);
        if (!production) {
          return {
            allowed: false,
            reason: `${server} runs apps (${String(req.details?.['apps'])}): bots log in as its admin only inside a production deploy you approved`,
            action:
              req.details?.['dev'] === true
                ? `Set up the bot workspace on ${server}'s page in the Supply Depot; dev_run then works there without touching the apps.`
                : `Build and test with dev_run (it runs in the bot workspace), or have the unit run it as a deploy task.`,
          };
        }
        return {
          allowed: false,
          reason: `${server} is a production server: bots reach it only inside a production deploy you approved`,
          action: 'Have the unit run it as a deploy task; it waits for your approval.',
        };
      },
    };
  }

  // ---------- Connecting (the Commander) ----------

  /** Pin the server's host keys, prove the key logs in, and put it in the depot. */
  async connect(input: z.output<typeof ConnectServerRequest>, ctx: WriteContext) {
    await this.requireKey(input.credentialName);
    const hostKeys = await this.scanHostKeys(input.host, input.port);
    const server: ServerAccess = {
      host: input.host,
      port: input.port,
      user: input.user,
      credentialName: input.credentialName,
      hostKeys,
      fingerprints: await this.ssh.fingerprints(hostKeys).catch(() => []),
      url: input.url || null,
      rsync: false,
      facts: null,
      workspace: null,
      apps: [],
    };
    const facts = await this.proveLogin(server);
    return this.record.create(
      'supply',
      {
        name: input.name,
        connected: true,
        spec: {
          kind: 'environment',
          details: { tier: input.tier },
          server: { ...server, facts, rsync: facts['rsync'] === 'yes' },
        },
      },
      ctx,
    );
  }

  /**
   * Change an environment. A new host, port, user or key is tested by logging in before
   * anything is saved, and so is the login of a plain environment that becomes a server. Host
   * keys are pinned again only for a new host or port, or when the Commander says the server
   * was reinstalled: a changed key is otherwise refused by ssh.
   */
  async update(
    supplyId: string,
    input: z.output<typeof UpdateEnvironmentRequest>,
    ctx: WriteContext,
  ) {
    const s = await this.record.requireActive('supply', supplyId);
    if (s.body.spec.kind !== 'environment') {
      throw new BadRequestException({
        message: `${s.body.name} is not an environment.`,
        action: 'Only servers and environments are edited here.',
      });
    }
    const sv = s.body.spec.server ?? null;
    const tier = s.body.spec.details['tier'] ?? 'staging';
    if (tier !== input.tier && (tier === 'production' || input.tier === 'production')) {
      const holders = (await this.record.listActive('unit')).filter((u) =>
        u.body.supplyIds.includes(supplyId),
      );
      if (holders.length) {
        throw new BadRequestException({
          message: `${s.body.name} is held by ${holders.map((u) => u.body.name).join(', ')}: moving it ${input.tier === 'production' ? 'to' : 'out of'} production would ${input.tier === 'production' ? 'give' : 'take away'} deploy rights.`,
          action:
            input.tier === 'production'
              ? 'Withdraw it from those units first, then give deploy rights by order in chat, which asks you to confirm.'
              : 'Deploy rights cannot be taken back. Connect the server again as a separate environment instead.',
        });
      }
    }
    const login = input.server;
    if (input.tier === 'dev' && !login) {
      throw new BadRequestException({
        message: 'A dev environment is a server bots log in to.',
        action: 'Give its SSH login: host, user and key.',
      });
    }
    if (sv && !login) {
      throw new BadRequestException({
        message: `${s.body.name} is a server; it cannot stop being one.`,
        action: 'Keep its login, or connect a separate environment without one.',
      });
    }

    const changed: string[] = [];
    if (input.name !== s.body.name) changed.push(`name ${s.body.name} → ${input.name}`);
    if (input.tier !== tier) changed.push(`tier ${tier} → ${input.tier}`);
    let next: ServerAccess | null = sv;
    if (login && !sv) {
      // A plain environment becomes a server: pin its keys and prove the login, as on connect.
      await this.requireKey(login.credentialName);
      const hostKeys = await this.scanHostKeys(login.host, login.port);
      const fresh: ServerAccess = {
        host: login.host,
        port: login.port,
        user: login.user,
        credentialName: login.credentialName,
        hostKeys,
        fingerprints: await this.ssh.fingerprints(hostKeys).catch(() => []),
        url: login.url || null,
        rsync: false,
        facts: null,
        workspace: null,
        apps: [],
      };
      const facts = await this.proveLogin(fresh);
      next = { ...fresh, facts, rsync: facts['rsync'] === 'yes' };
      changed.push(`now a server: ${login.user}@${login.host}:${login.port}`);
    } else if (login && sv) {
      const moved = login.host !== sv.host || login.port !== sv.port;
      const relogin = moved || login.user !== sv.user || login.credentialName !== sv.credentialName;
      next = { ...sv, url: login.url || null };
      if ((login.url || null) !== sv.url) changed.push('URL');
      if (relogin || input.repinHostKey) {
        await this.requireKey(login.credentialName);
        next = {
          ...next,
          host: login.host,
          port: login.port,
          user: login.user,
          credentialName: login.credentialName,
        };
        if (moved || input.repinHostKey) {
          next.hostKeys = await this.scanHostKeys(login.host, login.port);
          next.fingerprints = await this.ssh.fingerprints(next.hostKeys).catch(() => []);
          changed.push(
            moved ? `address ${login.user}@${login.host}:${login.port}` : 'host key pinned again',
          );
        }
        if (login.user !== sv.user) changed.push(`user ${sv.user} → ${login.user}`);
        if (login.credentialName !== sv.credentialName) changed.push(`key ${login.credentialName}`);
        const facts = await this.proveLogin(next);
        next = { ...next, facts, rsync: facts['rsync'] === 'yes' };
      }
    }
    if (!changed.length) return s;
    const reason = ctx.reason || `${s.body.name} edited: ${changed.join(', ')}`;
    const revised = await this.record.revise(
      'supply',
      supplyId,
      (b) => ({
        ...b,
        name: input.name,
        spec: {
          kind: 'environment',
          details: { ...(b.spec.kind === 'environment' ? b.spec.details : {}), tier: input.tier },
          server: next,
        },
      }),
      { ...ctx, reason },
    );
    // Models served from it are reached at its new address.
    if (sv && login && login.host !== sv.host) {
      for (const id of sv.apps.flatMap((a) => a.provides)) {
        await this.record.revise(
          'supply',
          id,
          (b) =>
            b.spec.kind === 'model'
              ? {
                  ...b,
                  spec: {
                    ...b.spec,
                    baseUrl: b.spec.baseUrl.replace(`//${sv.host}:`, `//${login.host}:`),
                  },
                }
              : b,
          { ...ctx, reason: `${s.body.name} moved to ${login.host}` },
        );
      }
    }
    return revised;
  }

  private async requireKey(credential: string): Promise<void> {
    if (credential.startsWith(OFFICER_SECRET_PREFIX) || !(await this.secrets.exists(credential))) {
      throw new BadRequestException({
        message: `No credential called "${credential}" is stored.`,
        action:
          'Store the SSH private key as a credential in the Supply Depot (multi-line), then choose it here.',
      });
    }
  }

  private async scanHostKeys(host: string, port: number): Promise<string[]> {
    const hostKeys = await this.ssh.scan(host, port).catch(() => []);
    if (!hostKeys.length) {
      throw new BadRequestException({
        message: `Could not reach SSH on ${host}:${port}.`,
        action: 'Check the host name, the port and that sshd is running and reachable from here.',
      });
    }
    return hostKeys;
  }

  /** Log in with the key and read what the server is. Refuses if the login fails. */
  private async proveLogin(server: ServerAccess): Promise<Record<string, string>> {
    const probe = await this.exec(server, `echo orbot-ok; ${await this.factsScript()}`, {});
    if (probe.exitCode !== 0 || !probe.output.includes('orbot-ok')) {
      throw new BadRequestException({
        message: `The key "${server.credentialName}" could not log in as ${server.user}@${server.host}: ${this.firstLine(probe.output)}`,
        action:
          'Add the public half of the key to ~/.ssh/authorized_keys for that user. A key with a passphrase cannot be used: store one without. If the server was reinstalled, tick "pin its new host key".',
      });
    }
    return parseKv(this.redaction.clean(probe.output));
  }

  /** Log in again with the stored key (e.g. after changing the server), and refresh its facts. */
  async check(supplyId: string, actor: string): Promise<{ ok: boolean; output: string }> {
    const s = await this.require(supplyId);
    const r = await this.exec(s.body.spec.server, `echo orbot-ok; ${await this.factsScript()}`, {});
    const ok = r.exitCode === 0 && r.output.includes('orbot-ok');
    const output = this.redaction.clean(r.output.replace('orbot-ok\n', '')).trim();
    if (ok) {
      const facts = parseKv(output);
      await this.reviseServer(
        supplyId,
        (sv) => ({ ...sv, facts, rsync: facts['rsync'] === 'yes' }),
        { actor, reason: `Logged in to ${s.body.name} and refreshed what it is` },
      );
    }
    return { ok, output: ok ? this.describeFacts(parseKv(output)) : output };
  }

  private describeFacts(f: Record<string, string>): string {
    return [f['os'], f['gpu'] && f['gpu'] !== 'none (no nvidia-smi)' ? f['gpu'] : null]
      .filter(Boolean)
      .join(' · ');
  }

  private async factsScript(): Promise<string> {
    const script = await readFile(join(this.config.deployDir, 'server', 'facts.sh'), 'utf8');
    return `bash -s <<'ORBOT_FACTS'\n${script}\nORBOT_FACTS`;
  }

  /** Write a new version of the server with its access details changed. */
  async reviseServer(
    supplyId: string,
    change: (server: ServerAccess) => ServerAccess,
    ctx: WriteContext,
  ): Promise<Server> {
    return (await this.record.revise(
      'supply',
      supplyId,
      (b) => {
        if (b.spec.kind !== 'environment' || !b.spec.server) return b;
        return { ...b, spec: { ...b.spec, server: change(b.spec.server) } };
      },
      ctx,
    )) as Server;
  }

  // ---------- The bot workspace ----------

  /**
   * Give bots their own login on the server for dev work: a user without sudo or docker, with
   * a key ORBOT generates (a credential, used by name). dev_run and dev_fetch use it from then
   * on, so bots cannot stop or change what is installed on the server.
   */
  async setupWorkspace(supplyId: string, ctx: WriteContext): Promise<Server> {
    const s = await this.require(supplyId);
    const credentialName = `${slug(s.body.name)}.${WORKSPACE_USER}.key`;
    const dir = await mkdtemp(join(tmpdir(), 'orbot-keygen-'));
    let publicKey: string;
    try {
      const keyFile = join(dir, 'key');
      await run('ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        `${WORKSPACE_USER}@${s.body.name}`,
        '-f',
        keyFile,
      ]);
      const privateKey = await readFile(keyFile, 'utf8');
      publicKey = (await readFile(`${keyFile}.pub`, 'utf8')).trim();
      await this.supply.storeCredential(
        { name: credentialName, value: privateKey },
        { actor: ctx.actor, reason: `Login key for the bot workspace on ${s.body.name}` },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const script = await readFile(join(this.config.deployDir, 'server', 'workspace.sh'), 'utf8');
    const r = await this.admin(s, 'sudo -n bash -s  # deploy/server/workspace.sh', ctx.actor, {
      stdin: Buffer.from(
        `export WORKSPACE_USER='${WORKSPACE_USER}'\nexport PUBLIC_KEY='${publicKey}'\n${script}`,
      ),
    });
    if (r.exitCode !== 0 || !r.output.includes('orbot-workspace-ok')) {
      throw new BadRequestException({
        message: `Could not set up the bot workspace on ${s.body.name}: ${this.firstLine(r.output)}`,
        action: this.failureHelp(r.output, s),
      });
    }
    const login: SshTarget = { ...s.body.spec.server, user: WORKSPACE_USER };
    const probe = await this.ssh.run(
      login,
      await this.secrets.reveal(credentialName),
      'echo orbot-ok',
      {
        timeoutMs: 60_000,
      },
    );
    if (!probe.output.includes('orbot-ok')) {
      throw new BadRequestException({
        message: `The bot workspace user was created, but ORBOT could not log in as ${WORKSPACE_USER}: ${this.firstLine(probe.output)}`,
        action: `Check that sshd allows ${WORKSPACE_USER} to log in (AllowUsers / AllowGroups in /etc/ssh/sshd_config), then set it up again.`,
      });
    }
    const revised = await this.reviseServer(
      supplyId,
      (sv) => ({ ...sv, workspace: { user: WORKSPACE_USER, credentialName } }),
      ctx,
    );
    await this.record.event(
      'server.workspace',
      { supplyId, server: s.body.name, user: WORKSPACE_USER },
      {},
      ctx.actor,
    );
    return revised;
  }

  /** What to do about a failed admin command, from its output. */
  failureHelp(output: string, s: Server): string {
    const user = s.body.spec.server.user;
    if (/password is required|not in the sudoers|may not run sudo/i.test(output)) {
      return `Give ${user} passwordless sudo on the server (e.g. a line "${user} ALL=(ALL) NOPASSWD:ALL" in /etc/sudoers.d/orbot), then try again.`;
    }
    if (
      /could not resolve|connection refused|timed out|no route to host|network is unreachable|host key verification failed|permission denied \(publickey/i.test(
        output,
      )
    ) {
      return `ORBOT could not log in to ${s.body.name}: check it is on and reachable, then use Check login on its page.`;
    }
    return "The command's output is in the server's record.";
  }

  /**
   * A command ORBOT runs as the server's admin login on the Commander's behalf (installing an
   * app, setting up the workspace). On the record as `server.command`, output redacted.
   */
  async admin(
    s: Server,
    command: string,
    actor: string,
    opts: { stdin?: Buffer; timeoutMs?: number; record?: boolean } = {},
  ): Promise<ServerResult> {
    const started = Date.now();
    let r: ServerResult;
    try {
      const key = await this.secrets.reveal(s.body.spec.server.credentialName);
      r = await this.ssh.run(s.body.spec.server, key, command, {
        ...(opts.stdin ? { stdin: opts.stdin } : {}),
        timeoutMs: opts.timeoutMs ?? COMMAND_TIMEOUT_MS,
      });
    } catch (err) {
      r = { exitCode: null, output: (err as Error).message };
    }
    const output = this.redaction.clean(r.output);
    if (opts.record !== false) {
      await this.record.event(
        'server.command',
        {
          supplyId: s.entityId,
          server: s.body.name,
          command,
          exitCode: r.exitCode,
          output: tail(output, RECORD_OUTPUT),
          durationMs: Date.now() - started,
        },
        {},
        actor,
      );
    }
    return { exitCode: r.exitCode, output };
  }

  // ---------- Bots ----------

  /** The servers a unit holds. */
  async forUnit(unitId: string): Promise<Server[]> {
    const unit = await this.record.requireActive('unit', unitId);
    const out: Server[] = [];
    for (const id of unit.body.supplyIds) {
      const s = await this.record.getActive('supply', id);
      if (s?.body.connected && s.body.spec.kind === 'environment' && s.body.spec.server) {
        out.push(s as Server);
      }
    }
    return out;
  }

  async list(unitId: string): Promise<ServerInfo[]> {
    return (await this.forUnit(unitId)).map((s) => ({
      name: s.body.name,
      tier: s.body.spec.details['tier'] ?? 'staging',
      host: s.body.spec.server.host,
      user: s.body.spec.server.user,
      url: s.body.spec.server.url,
      devUser: s.body.spec.server.workspace?.user ?? s.body.spec.server.user,
      gpu: s.body.spec.server.facts?.['gpu']?.startsWith('none')
        ? null
        : (s.body.spec.server.facts?.['gpu'] ?? null),
      apps: s.body.spec.server.apps.filter((a) => a.status !== 'removed').map((a) => a.name),
    }));
  }

  /** A bot runs a command on a server its unit holds. */
  async run(
    task: RecordVersion<TaskBody>,
    bot: Principal,
    refs: RecordEventRefs,
    name: string,
    command: string,
    signal: AbortSignal,
  ): Promise<ServerResult> {
    const s = await this.authorize(task, bot, name, command);
    return this.recorded(s, task, bot, refs, command, () =>
      this.exec(s.body.spec.server, command, { signal }, bot, task),
    );
  }

  /** A bot copies its committed work (HEAD of the task branch) into a directory on a server. */
  async upload(
    task: RecordVersion<TaskBody>,
    bot: Principal,
    refs: RecordEventRefs,
    name: string,
    remotePath: string,
    signal: AbortSignal,
  ): Promise<ServerResult> {
    if (!task.body.workspace) throw new Error('This task has no workspace to copy.');
    if (!/^[A-Za-z0-9_./~-]+$/.test(remotePath) || remotePath.includes('..')) {
      throw new Error('The remote path may use letters, digits and / . _ - ~ only.');
    }
    const path = remotePath.startsWith('~/') ? `"$HOME"/${remotePath.slice(2)}` : remotePath;
    const command = `mkdir -p ${path} && tar -xf - -C ${path}`;
    const s = await this.authorize(task, bot, name, command);
    const ws = task.body.workspace.path;
    const commit = await git(ws, ['rev-parse', 'HEAD']);
    const result = await this.recorded(
      s,
      task,
      bot,
      refs,
      `upload ${commit.slice(0, 10)} to ${remotePath}`,
      async () => {
        const archive = await gitArchive(ws);
        return this.exec(s.body.spec.server, command, { signal, stdin: archive }, bot, task);
      },
    );
    if (result.exitCode === 0) {
      await this.record.event(
        'deployment',
        { environment: s.body.name, ref: `deploy/${s.body.name}`, commit },
        refs,
        actorRef(bot),
      );
    }
    return result;
  }

  /**
   * A bot's folder on a dev server, relative to the login's home: one per repository and bot.
   * A bot works one task at a time, so its folder is its own, and what it installed there
   * (dependencies, build caches) is still there for its next task on the same repository.
   */
  private async devDir(task: RecordVersion<TaskBody>, bot: Principal): Promise<string> {
    const repo = task.body.repoSupplyId
      ? await this.record.getActive('supply', task.body.repoSupplyId)
      : null;
    return `orbot-dev/${slug(repo?.body.name ?? 'workspace')}/${slug(bot.displayName)}`;
  }

  /** On a dev server: sync the working tree (uncommitted edits too) to the bot's folder, then run. */
  async devRun(
    task: RecordVersion<TaskBody>,
    bot: Principal,
    refs: RecordEventRefs,
    name: string | null,
    command: string,
    signal: AbortSignal,
  ): Promise<ServerResult> {
    if (!task.body.workspace) throw new Error('This task has no workspace to build.');
    const s = await this.devServer(task, bot, name, command);
    const dir = await this.devDir(task, bot);
    const ws = task.body.workspace.path;
    const login = this.devLogin(s);
    return this.recorded(s, task, bot, refs, `[${login.user}:${dir}] ${command}`, async () => {
      const key = await this.useKey(login, bot, task);
      const sync = await this.ssh.sync(login, key, ws, dir, {
        rsync: s.body.spec.server.rsync,
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      });
      if (sync.exitCode !== 0) {
        return {
          exitCode: sync.exitCode,
          output: `Could not sync your working tree to ${s.body.name}:${dir}.\n${sync.output}`,
        };
      }
      return this.ssh.run(login, key, `cd ${dir} && ${command}`, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      });
    });
  }

  /** From a dev server: copy a file or directory from the bot's folder into the workspace. */
  async devFetch(
    task: RecordVersion<TaskBody>,
    bot: Principal,
    refs: RecordEventRefs,
    name: string | null,
    path: string,
    signal: AbortSignal,
  ): Promise<ServerResult> {
    if (!task.body.workspace) throw new Error('This task has no workspace.');
    const p = path.trim().replace(/^\.\//, '');
    if (!/^[A-Za-z0-9_./@+-]+$/.test(p) || p.startsWith('/') || p.split('/').includes('..')) {
      throw new Error('Give a path inside your folder, e.g. package-lock.json or src/generated.');
    }
    if (p === '.git' || p.startsWith('.git/')) throw new Error('.git is not copied back.');
    const s = await this.devServer(task, bot, name, `fetch ${p}`);
    const dir = await this.devDir(task, bot);
    const ws = task.body.workspace.path;
    const login = this.devLogin(s);
    return this.recorded(s, task, bot, refs, `[${login.user}:${dir}] fetch ${p}`, async () => {
      const key = await this.useKey(login, bot, task);
      const r = await this.ssh.fetch(login, key, dir, p, ws, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      });
      return r.exitCode === 0 ? { exitCode: 0, output: `Copied ${p} into your workspace.` } : r;
    });
  }

  private async devServer(
    task: RecordVersion<TaskBody>,
    bot: Principal,
    name: string | null,
    command: string,
  ): Promise<Server> {
    const s = await this.authorize(task, bot, name ?? '', command, { dev: true });
    if (s.body.spec.details['tier'] !== 'dev') {
      throw new Error(
        `${s.body.name} is a ${s.body.spec.details['tier'] ?? 'staging'} server, not a dev server: use server_run there.`,
      );
    }
    return s;
  }

  /** Where dev work runs: the bot workspace once it is set up, else the server's login. */
  private devLogin(s: Server): ServerAccess {
    const sv = s.body.spec.server;
    return sv.workspace
      ? { ...sv, user: sv.workspace.user, credentialName: sv.workspace.credentialName }
      : sv;
  }

  private async authorize(
    task: RecordVersion<TaskBody>,
    bot: Principal,
    name: string,
    command: string,
    opts: { dev?: boolean } = {},
  ): Promise<Server> {
    const servers = await this.forUnit(task.body.unitId);
    const s = name.trim()
      ? servers.find((x) => x.body.name.toLowerCase() === name.trim().toLowerCase())
      : servers.find((x) => x.body.spec.details['tier'] === 'dev');
    if (!s && !name.trim()) {
      throw new Error(
        'Your unit holds no dev server. Build and test locally with run_script, or ask for one with blocked.',
      );
    }
    if (!s) {
      throw new Error(
        `Your unit holds no server called "${name}". ${servers.length ? `It holds: ${servers.map((x) => x.body.name).join(', ')}.` : 'It holds none: ask for one with blocked.'}`,
      );
    }
    const d = await this.policy.check({
      principal: bot,
      action: 'server.run',
      unitId: task.body.unitId,
      taskId: task.entityId,
      details: {
        server: s.body.name,
        supplyId: s.entityId,
        tier: s.body.spec.details['tier'] ?? 'staging',
        command: this.redaction.clean(command),
        ...this.appDetails(s, opts.dev === true),
      },
    });
    if (!d.allowed) throw new Error(`Refused: ${d.reason}. ${d.action ?? ''}`.trim());
    return s;
  }

  /** For the policy: which apps run on the server, and whether the bot works in the workspace. */
  private appDetails(s: Server, dev: boolean) {
    const apps = s.body.spec.server.apps.filter((a) => a.status !== 'removed');
    if (!apps.length) return {};
    return {
      hostsApps: true,
      apps: apps.map((a) => a.name).join(', '),
      dev,
      asWorkspace: dev && s.body.spec.server.workspace !== null,
    };
  }

  private async recorded(
    s: Server,
    task: RecordVersion<TaskBody>,
    bot: Principal,
    refs: RecordEventRefs,
    command: string,
    fn: () => Promise<ServerResult>,
  ): Promise<ServerResult> {
    const started = Date.now();
    let r: ServerResult;
    try {
      r = await fn();
    } catch (err) {
      r = { exitCode: null, output: (err as Error).message };
    }
    const output = this.redaction.clean(r.output);
    await this.record.event(
      'server.command',
      {
        supplyId: s.entityId,
        server: s.body.name,
        command,
        exitCode: r.exitCode,
        output: tail(output, RECORD_OUTPUT),
        durationMs: Date.now() - started,
      },
      refs,
      actorRef(bot),
    );
    return { exitCode: r.exitCode, output: tail(output, BOT_OUTPUT) };
  }

  /** Reveal the key for a bot's use, recording the use by name. */
  private async useKey(
    server: ServerAccess,
    bot: Principal,
    task: RecordVersion<TaskBody>,
  ): Promise<string> {
    const key = await this.secrets.reveal(server.credentialName);
    await this.record.event(
      'credential.used',
      { secretName: server.credentialName, purpose: `SSH to ${server.user}@${server.host}` },
      { unitId: task.body.unitId, taskId: task.entityId, botId: bot.id },
      actorRef(bot),
    );
    return key;
  }

  /** Reveal the key (recorded by name when a bot uses it) and run the command. */
  private async exec(
    server: ServerAccess,
    command: string,
    opts: { signal?: AbortSignal; stdin?: Buffer },
    bot?: Principal,
    task?: RecordVersion<TaskBody>,
  ): Promise<ServerResult> {
    const key =
      bot && task
        ? await this.useKey(server, bot, task)
        : await this.secrets.reveal(server.credentialName);
    return this.ssh.run(server, key, command, { ...opts, timeoutMs: COMMAND_TIMEOUT_MS });
  }

  async require(supplyId: string): Promise<Server> {
    const s = await this.record.requireActive('supply', supplyId);
    if (s.body.spec.kind !== 'environment' || !s.body.spec.server) {
      throw new BadRequestException({
        message: `${s.body.name} is not a server.`,
        action: 'Connect a server under Supply Depot → environment.',
      });
    }
    return s as Server;
  }

  firstLine(s: string): string {
    return this.redaction.clean(s.trim().split('\n').pop() ?? '').slice(0, 300) || 'no answer';
  }
}
