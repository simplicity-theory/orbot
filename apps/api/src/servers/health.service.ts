import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { RecordEventBody, ServerApp } from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { RecordService, type WriteContext } from '../record/record.service.js';
import { RedactionService } from '../redaction/redaction.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { AppsService } from './apps.service.js';
import { parseKv, ServersService, type Server } from './servers.service.js';

type Health = RecordEventBody<'server.health'>;
type Level = Health['status'];

/** A disk this full is degraded; this full, down. */
const DISK_WARN_PERCENT = 85;
const DISK_DOWN_PERCENT = 95;
/** Less free than this is degraded however big the disk (model weights are tens of GB). */
const DISK_WARN_FREE = 5 * 1024 ** 3;

const worst = (levels: Level[]): Level =>
  levels.includes('down') ? 'down' : levels.includes('degraded') ? 'degraded' : 'healthy';

/**
 * A server's health check, on demand: can ORBOT log in (and the bot workspace), are the
 * installed apps running (their status.sh, and for a model, does it answer from here), and how
 * full are the disks. The result is a `server.health` event; reading the server changes nothing.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly secrets: SecretsService,
    private readonly redaction: RedactionService,
    private readonly servers: ServersService,
    private readonly apps: AppsService,
  ) {}

  async check(supplyId: string, ctx: WriteContext) {
    const s = await this.servers.require(supplyId);
    const sv = s.body.spec.server;
    const disk = await readFile(join(this.config.deployDir, 'server', 'disk.sh'), 'utf8');
    const probe = await this.servers.admin(
      s,
      `echo orbot-ok; bash -s <<'ORBOT_DISK'\n${disk}\nORBOT_DISK`,
      ctx.actor,
      { record: false, timeoutMs: 60_000 },
    );
    const loggedIn = probe.exitCode === 0 && probe.output.includes('orbot-ok');
    const installed = sv.apps.filter((a) => a.status !== 'removed');

    let health: Health;
    if (!loggedIn) {
      const why = `${this.servers.firstLine(probe.output)}. ${this.servers.failureHelp(probe.output, s)}`;
      health = {
        supplyId,
        server: s.body.name,
        status: 'down',
        login: { ok: false, message: `Could not log in as ${sv.user}@${sv.host}: ${why}` },
        workspace: null,
        disks: [],
        apps: installed.map((a) => ({
          appId: a.id,
          name: a.name,
          status: 'down' as const,
          message: 'Not checked: ORBOT could not log in.',
        })),
      };
    } else {
      const disks = this.disks(probe.output);
      const workspace = sv.workspace ? await this.workspace(s) : null;
      const apps = [];
      for (const a of installed) apps.push(await this.app(s, a, ctx.actor));
      health = {
        supplyId,
        server: s.body.name,
        status: worst([
          ...disks.map((d) => d.status),
          ...apps.map((a) => a.status),
          workspace && !workspace.ok ? 'degraded' : 'healthy',
        ]),
        login: { ok: true, message: `Logged in as ${sv.user}@${sv.host}.` },
        workspace,
        disks,
        apps,
      };
    }
    return this.record.event('server.health', health, {}, ctx.actor);
  }

  private disks(output: string): Health['disks'] {
    return output
      .split('\n')
      .filter((l) => l.startsWith('disk='))
      .map((l) => {
        const [mount = '?', size, used, avail] = l.slice(5).split('|');
        const sizeBytes = Number(size) || 0;
        const usedBytes = Number(used) || 0;
        const availBytes = Number(avail) || 0;
        // As df counts it: used of what non-root users can have.
        const usedPercent = Math.round((usedBytes / Math.max(1, usedBytes + availBytes)) * 100);
        const status: Level =
          usedPercent >= DISK_DOWN_PERCENT
            ? 'down'
            : usedPercent >= DISK_WARN_PERCENT || availBytes < DISK_WARN_FREE
              ? 'degraded'
              : 'healthy';
        return { mount, sizeBytes, usedBytes, availBytes, usedPercent, status };
      });
  }

  private async workspace(s: Server): Promise<{ ok: boolean; message: string }> {
    const ws = s.body.spec.server.workspace!;
    try {
      const key = await this.secrets.reveal(ws.credentialName);
      const r = await this.servers.ssh.run(
        { ...s.body.spec.server, user: ws.user },
        key,
        'echo orbot-ok',
        { timeoutMs: 60_000 },
      );
      return r.output.includes('orbot-ok')
        ? { ok: true, message: `Bots log in as ${ws.user}.` }
        : {
            ok: false,
            message: `Bots cannot log in as ${ws.user}: ${this.servers.firstLine(r.output)}. Set up the bot workspace again.`,
          };
    } catch (err) {
      return { ok: false, message: this.redaction.clean((err as Error).message) };
    }
  }

  /** One app: its own status.sh on the server, then (for a model) whether it answers here. */
  private async app(s: Server, a: ServerApp, actor: string): Promise<Health['apps'][number]> {
    const base = { appId: a.id, name: a.name };
    if (a.status === 'installing' || a.status === 'removing') {
      return { ...base, status: 'degraded', message: `${a.status}: ${a.message ?? 'starting'}` };
    }
    if (a.status === 'failed') {
      return {
        ...base,
        status: 'down',
        message: `Its last install failed: ${a.message ?? 'see its log'}`,
      };
    }
    const r = await this.servers.admin(
      s,
      `sudo -n /bin/bash /opt/orbot/apps/${a.app}/status.sh`,
      actor,
      { record: false, timeoutMs: 60_000 },
    );
    if (r.exitCode !== 0) {
      return {
        ...base,
        status: 'down',
        message: `Could not read its status: ${this.servers.firstLine(r.output)}. ${this.servers.failureHelp(r.output, s)}`,
      };
    }
    const rep = parseKv(r.output);
    const parts = [`service ${rep['service'] || 'unknown'}`];
    if (rep['health']) parts.push(`API ${rep['health']}`);
    if (rep['models']) parts.push(`serves ${rep['models']}`);
    let status: Level =
      rep['service'] === 'active' && (!rep['health'] || rep['health'] === 'ok')
        ? 'healthy'
        : 'down';
    for (const id of a.provides) {
      const m = await this.apps.checkModel(id, actor).catch((err: Error) => ({
        ok: false,
        message: err.message,
      }));
      if (!m.ok) {
        status = worst([status, 'degraded']);
        parts.push(`not reachable from ORBOT: ${m.message}`);
      } else if (status === 'healthy') {
        parts.push('answers from ORBOT');
      }
    }
    return { ...base, status, message: this.redaction.clean(parts.join(' · ')) };
  }
}
