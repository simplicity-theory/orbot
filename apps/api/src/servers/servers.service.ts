import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  actorRef,
  type ConnectServerRequest,
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
import { OFFICER_SECRET_PREFIX } from '../officers/officers.service.js';
import { PolicyService } from '../policy/policy.service.js';
import type { WriteContext } from '../record/record.service.js';
import { RecordService } from '../record/record.service.js';
import { RedactionService } from '../redaction/redaction.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { SshClient } from './ssh.client.js';

type Server = RecordVersion<SupplyBody> & {
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

const tail = (s: string, n: number) => (s.length > n ? `[…]\n${s.slice(-n)}` : s);

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
    private readonly record: RecordService,
    private readonly secrets: SecretsService,
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
        if (req.action !== 'server.run' || req.details?.['tier'] !== 'production') return null;
        const task = req.taskId ? await this.record.getActive('task', req.taskId) : null;
        if (task?.body.kind === 'deploy' && task.body.approval?.status === 'approved') return null;
        return {
          allowed: false,
          reason: `${String(req.details['server'])} is a production server: bots reach it only inside a production deploy you approved`,
          action: 'Have the unit run it as a deploy task; it waits for your approval.',
        };
      },
    };
  }

  // ---------- Connecting (the Commander) ----------

  /** Pin the server's host keys, prove the key logs in, and put it in the depot. */
  async connect(input: z.output<typeof ConnectServerRequest>, ctx: WriteContext) {
    const credential = input.credentialName;
    if (credential.startsWith(OFFICER_SECRET_PREFIX) || !(await this.secrets.exists(credential))) {
      throw new BadRequestException({
        message: `No credential called "${credential}" is stored.`,
        action:
          'Store the SSH private key as a credential in the Supply Depot (multi-line), then choose it here.',
      });
    }
    const hostKeys = await this.ssh.scan(input.host, input.port).catch(() => []);
    if (!hostKeys.length) {
      throw new BadRequestException({
        message: `Could not reach SSH on ${input.host}:${input.port}.`,
        action: 'Check the host name, the port and that sshd is running and reachable from here.',
      });
    }
    const server: ServerAccess = {
      host: input.host,
      port: input.port,
      user: input.user,
      credentialName: credential,
      hostKeys,
      fingerprints: await this.ssh.fingerprints(hostKeys).catch(() => []),
      url: input.url || null,
    };
    const probe = await this.exec(server, 'echo orbot-ok', {});
    if (probe.exitCode !== 0 || !probe.output.includes('orbot-ok')) {
      throw new BadRequestException({
        message: `The key "${credential}" could not log in as ${input.user}@${input.host}: ${this.firstLine(probe.output)}`,
        action:
          'Add the public half of the key to ~/.ssh/authorized_keys for that user. A key with a passphrase cannot be used: store one without.',
      });
    }
    return this.record.create(
      'supply',
      {
        name: input.name,
        connected: true,
        spec: { kind: 'environment', details: { tier: input.tier }, server },
      },
      ctx,
    );
  }

  /** Log in again with the stored key (e.g. after changing the server). */
  async check(supplyId: string): Promise<{ ok: boolean; output: string }> {
    const s = await this.require(supplyId);
    const r = await this.exec(s.body.spec.server, 'echo orbot-ok; uname -a', {});
    return {
      ok: r.exitCode === 0 && r.output.includes('orbot-ok'),
      output: this.redaction.clean(r.output.replace('orbot-ok\n', '')).trim(),
    };
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

  private async authorize(
    task: RecordVersion<TaskBody>,
    bot: Principal,
    name: string,
    command: string,
  ): Promise<Server> {
    const servers = await this.forUnit(task.body.unitId);
    const s = servers.find((x) => x.body.name.toLowerCase() === name.trim().toLowerCase());
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
      },
    });
    if (!d.allowed) throw new Error(`Refused: ${d.reason}. ${d.action ?? ''}`.trim());
    return s;
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

  /** Reveal the key (recorded by name when a bot uses it) and run the command. */
  private async exec(
    server: ServerAccess,
    command: string,
    opts: { signal?: AbortSignal; stdin?: Buffer },
    bot?: Principal,
    task?: RecordVersion<TaskBody>,
  ): Promise<ServerResult> {
    const key = await this.secrets.reveal(server.credentialName);
    if (bot && task) {
      await this.record.event(
        'credential.used',
        { secretName: server.credentialName, purpose: `SSH to ${server.user}@${server.host}` },
        { unitId: task.body.unitId, taskId: task.entityId, botId: bot.id },
        actorRef(bot),
      );
    }
    return this.ssh.run(server, key, command, { ...opts, timeoutMs: COMMAND_TIMEOUT_MS });
  }

  private async require(supplyId: string): Promise<Server> {
    const s = await this.record.requireActive('supply', supplyId);
    if (s.body.spec.kind !== 'environment' || !s.body.spec.server) {
      throw new BadRequestException({
        message: `${s.body.name} is not a server.`,
        action: 'Connect a server under Supply Depot → environment.',
      });
    }
    return s as Server;
  }

  private firstLine(s: string): string {
    return this.redaction.clean(s.trim().split('\n').pop() ?? '').slice(0, 300) || 'no answer';
  }
}
