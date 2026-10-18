import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  APP_SETTING_VALUE,
  AppManifest,
  type AppProgressView,
  InstallAppRequest,
  type ModelCheckView,
  type ModelSupply,
  type ServerApp,
  type SupplyBody,
} from '@orbot/shared';
import type { z } from 'zod';
import { Background } from '../common/background.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { OFFICER_SECRET_PREFIX } from '../officers/officers.service.js';
import { RecordService, type WriteContext } from '../record/record.service.js';
import { RedactionService } from '../redaction/redaction.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { SupplyService } from '../supply/supply.service.js';
import { parseKv, ServersService, slug, tail, type Server } from './servers.service.js';

const run = promisify(execFile);

/** The actor for what ORBOT records while following an install. */
const DEPOT = 'system:depot';
/** Log kept on the record per install event (the tail). */
const RECORD_LOG = 6_000;
/** A credential value may go into the app's environment file only if it is this plain. */
const SECRET_VALUE = /^[A-Za-z0-9._~+/=:-]+$/;

type Action = 'install' | 'uninstall';

/**
 * Apps on servers. An app is a folder in deploy/apps (manifest + scripts). Installing one
 * copies it to /opt/orbot on the server, writes its settings to a root-only environment file
 * and starts its install.sh under systemd-run, so it keeps going if ORBOT or the connection
 * stops. ORBOT then follows the state file the script writes until it is done or failed.
 * An app that provides a model adds it to the Supply Depot.
 */
@Injectable()
export class AppsService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly secrets: SecretsService,
    private readonly supply: SupplyService,
    private readonly servers: ServersService,
    private readonly redaction: RedactionService,
    private readonly background: Background,
  ) {}

  onApplicationBootstrap(): void {
    // Installs that were running when ORBOT stopped are picked up again by the first poll.
    if (this.config.appsPollMs > 0) {
      this.timer = setInterval(() => void this.pollAll(), this.config.appsPollMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------- The catalog ----------

  /** Every app in deploy/apps, read fresh so an edited manifest applies at once. */
  async catalog(): Promise<AppManifest[]> {
    const dir = join(this.config.deployDir, 'apps');
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: AppManifest[] = [];
    for (const name of names.sort()) {
      const raw = await readFile(join(dir, name, 'app.json'), 'utf8').catch(() => null);
      if (!raw) continue;
      const m = AppManifest.safeParse(JSON.parse(raw));
      if (m.success && m.data.id === name) out.push(m.data);
    }
    return out;
  }

  private async manifest(app: string): Promise<AppManifest> {
    const m = (await this.catalog()).find((x) => x.id === app);
    if (!m) {
      throw new NotFoundException({
        message: `There is no app called "${app}" in deploy/apps.`,
        action: 'Choose one of the apps listed on the server’s page.',
      });
    }
    return m;
  }

  // ---------- Installing ----------

  async install(supplyId: string, req: z.output<typeof InstallAppRequest>, ctx: WriteContext) {
    const s = await this.servers.require(supplyId);
    const m = await this.manifest(req.app);
    const existing = s.body.spec.server.apps.find((a) => a.app === m.id && a.status !== 'removed');
    if (existing && (existing.status === 'installing' || existing.status === 'removing')) {
      throw new ConflictException({
        message: `${m.name} is already ${existing.status} on ${s.body.name}.`,
        action: 'Wait for it to finish; its progress is on the server’s page.',
      });
    }
    const settings = this.validateSettings(m, req.settings);
    const credentials = await this.chooseCredentials(m, s, req.credentials, existing, ctx);
    const app: ServerApp = {
      id: existing?.id ?? randomUUID(),
      app: m.id,
      name: m.name,
      status: 'installing',
      settings,
      credentials,
      message: 'starting',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      provides: existing?.provides ?? [],
      report: existing?.report ?? null,
    };
    const revised = await this.saveApp(supplyId, app, ctx);
    await this.event(s, app, 'started', null, '', ctx.actor);
    this.background.run(`server:${supplyId}`, `install ${m.id}`, () =>
      this.launchOrFail(supplyId, app.id, 'install', ctx.actor),
    );
    return revised;
  }

  async uninstall(supplyId: string, appId: string, ctx: WriteContext) {
    const s = await this.servers.require(supplyId);
    const app = this.findApp(s, appId);
    if (app.status === 'installing' || app.status === 'removing') {
      throw new ConflictException({
        message: `${app.name} is ${app.status}; wait for it to finish.`,
        action: 'Its progress is on the server’s page.',
      });
    }
    const revised = await this.saveApp(
      supplyId,
      {
        ...app,
        status: 'removing',
        message: 'starting',
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
      ctx,
    );
    this.background.run(`server:${supplyId}`, `uninstall ${app.app}`, () =>
      this.launchOrFail(supplyId, appId, 'uninstall', ctx.actor),
    );
    return revised;
  }

  private validateSettings(m: AppManifest, given: Record<string, string | number | boolean>) {
    const unknown = Object.keys(given).filter((k) => !m.settings.some((x) => x.key === k));
    if (unknown.length) {
      throw new BadRequestException({
        message: `${m.name} has no setting ${unknown.join(', ')}.`,
        action: 'Use the settings in the install form.',
      });
    }
    const out: Record<string, string | number | boolean> = {};
    for (const def of m.settings) {
      const v = given[def.key] ?? def.default;
      const bad = (why: string) =>
        new BadRequestException({
          message: `${def.label}: ${why}`,
          action: 'Correct it and install again.',
        });
      if (def.type === 'boolean') {
        if (typeof v !== 'boolean') throw bad('must be on or off.');
        out[def.key] = v;
      } else if (def.type === 'integer' || def.type === 'number') {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n) || (def.type === 'integer' && !Number.isInteger(n))) {
          throw bad(`must be ${def.type === 'integer' ? 'a whole number' : 'a number'}.`);
        }
        if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
          throw bad(`must be between ${def.min ?? '−∞'} and ${def.max ?? '∞'}.`);
        }
        out[def.key] = n;
      } else {
        const t = String(v).trim();
        if (!APP_SETTING_VALUE.test(t)) {
          throw bad('may use letters, digits, spaces and . _ / : @ + = , - only.');
        }
        out[def.key] = t;
      }
    }
    return out;
  }

  /** Generated secrets get a credential (kept across reinstalls); chosen ones must exist. */
  private async chooseCredentials(
    m: AppManifest,
    s: Server,
    given: Record<string, string | null>,
    existing: ServerApp | undefined,
    ctx: WriteContext,
  ): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const def of m.secrets) {
      if (def.generate) {
        const name =
          existing?.credentials[def.key] ?? `${slug(s.body.name)}.${m.id}.${slug(def.key)}`;
        if (!(await this.secrets.exists(name))) {
          await this.supply.storeCredential(
            { name, value: randomBytes(24).toString('base64url') },
            { actor: ctx.actor, reason: `${def.label} for ${m.name} on ${s.body.name}, generated` },
          );
        }
        out[def.key] = name;
        continue;
      }
      const name = given[def.key]?.trim() || null;
      if (!name && !def.optional) {
        throw new BadRequestException({
          message: `${m.name} needs ${def.label}.`,
          action: 'Store it as a credential in the Supply Depot, then choose it here.',
        });
      }
      if (name && (name.startsWith(OFFICER_SECRET_PREFIX) || !(await this.secrets.exists(name)))) {
        throw new BadRequestException({
          message: `No credential called "${name}" is stored.`,
          action: 'Store it in the Supply Depot first.',
        });
      }
      out[def.key] = name;
    }
    return out;
  }

  private async launchOrFail(supplyId: string, appId: string, action: Action, actor: string) {
    try {
      await this.launch(supplyId, appId, action, actor);
    } catch (err) {
      const e = err as { response?: { message?: string }; message: string };
      const why = this.redaction.clean(e.response?.message ?? e.message);
      await this.finish(supplyId, appId, action, 'failed', `could not start: ${why}`, '');
    }
  }

  /** Copy the app to the server, write its settings and start its script under systemd-run. */
  private async launch(supplyId: string, appId: string, action: Action, actor: string) {
    const s = await this.servers.require(supplyId);
    const app = this.findApp(s, appId);
    const m = await this.manifest(app.app);
    const unit = `orbot-app-${m.id}-${action}`;
    const log = `/var/log/orbot/${m.id}-${action}.log`;
    const state = `/var/lib/orbot/apps/${m.id}/state`;

    const bundle = await run(
      'tar',
      ['-C', this.config.deployDir, '-cf', '-', 'lib', `apps/${m.id}`],
      {
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const steps: { command: string; stdin?: Buffer }[] = [
      {
        command: `sudo -n install -d -m 755 /opt/orbot && sudo -n rm -rf /opt/orbot/lib /opt/orbot/apps/${m.id} && sudo -n tar -xf - --no-same-owner -C /opt/orbot`,
        stdin: bundle.stdout,
      },
    ];
    if (action === 'install') {
      steps.push({
        command: `sudo -n install -d -m 700 /etc/orbot/apps && sudo -n sh -c 'umask 077 && cat > /etc/orbot/apps/${m.id}.env'`,
        stdin: Buffer.from(await this.envFile(m, app, actor)),
      });
    }
    steps.push({
      command: [
        `sudo -n install -d -m 755 /var/log/orbot /var/lib/orbot/apps/${m.id}`,
        `echo 'running start' | sudo -n tee ${state} >/dev/null`,
        `sudo -n sh -c ': > ${log}'`,
        `(sudo -n systemctl reset-failed ${unit} 2>/dev/null || true)`,
        `sudo -n systemd-run --unit=${unit} --collect --description='ORBOT: ${action} ${m.name}' -p StandardOutput=append:${log} -p StandardError=append:${log} /bin/bash /opt/orbot/apps/${m.id}/${action}.sh`,
      ].join(' && '),
    });
    for (const st of steps) {
      const r = await this.servers.admin(s, st.command, actor, st.stdin ? { stdin: st.stdin } : {});
      if (r.exitCode !== 0) {
        const why = `${this.servers.firstLine(r.output)}. ${this.servers.failureHelp(r.output, s)}`;
        await this.finish(supplyId, appId, action, 'failed', `could not start: ${why}`, r.output);
        return;
      }
    }
  }

  /** `KEY='value'` lines for systemd's EnvironmentFile and bash alike. Secret values only here. */
  private async envFile(m: AppManifest, app: ServerApp, actor: string): Promise<string> {
    const lines = Object.entries(app.settings).map(([k, v]) => `${k}='${String(v)}'`);
    for (const def of m.secrets) {
      const name = app.credentials[def.key];
      if (!name) {
        lines.push(`${def.key}=''`);
        continue;
      }
      const value = await this.secrets.reveal(name);
      if (!SECRET_VALUE.test(value)) {
        throw new BadRequestException({
          message: `The credential ${name} has characters that cannot go into ${m.name}'s settings.`,
          action: 'Store it again without spaces, quotes or line breaks.',
        });
      }
      await this.record.event(
        'credential.used',
        {
          secretName: name,
          purpose: `${def.label} for ${m.name}, written to the server's root-only settings file`,
        },
        {},
        actor,
      );
      lines.push(`${def.key}='${value}'`);
    }
    return lines.join('\n') + '\n';
  }

  // ---------- Following ----------

  /** Follow every install and removal in progress. */
  async pollAll(): Promise<void> {
    for (const s of await this.record.listActive('supply')) {
      if (s.body.spec.kind !== 'environment' || !s.body.spec.server) continue;
      for (const a of s.body.spec.server.apps) {
        if (a.status === 'installing' || a.status === 'removing') {
          this.background.run(`server:${s.entityId}`, `poll ${a.app}`, () =>
            this.poll(s.entityId, a.id),
          );
        }
      }
    }
  }

  /** Read an install's state from the server and record the outcome once there is one. */
  async poll(supplyId: string, appId: string): Promise<void> {
    const s = await this.servers.require(supplyId);
    const app = this.findApp(s, appId);
    if (app.status !== 'installing' && app.status !== 'removing') return;
    const action: Action = app.status === 'installing' ? 'install' : 'uninstall';
    const p = await this.progress(supplyId, appId);
    if (p.state === 'unreachable') return; // try again next time
    const m = await this.manifest(app.app);

    if (action === 'install' && p.state === 'done') {
      await this.installed(s, app, m, p.log);
    } else if (action === 'uninstall' && p.state === 'removed') {
      await this.finish(supplyId, appId, action, 'removed', null, p.log);
    } else if (p.state.startsWith('failed')) {
      await this.finish(
        supplyId,
        appId,
        action,
        'failed',
        p.state.replace(/^failed\s*/, ''),
        p.log,
      );
    } else if (!p.active && (p.state.startsWith('running') || p.state === 'missing')) {
      await this.finish(
        supplyId,
        appId,
        action,
        'failed',
        `${p.state.replace(/^running\s*/, '')}: it stopped without finishing`,
        p.log,
      );
    } else if (Date.now() - Date.parse(app.startedAt) > m.installMinutes * 60_000) {
      await this.servers.admin(s, `sudo -n systemctl stop orbot-app-${m.id}-${action}`, DEPOT);
      await this.finish(
        supplyId,
        appId,
        action,
        'failed',
        `took longer than ${m.installMinutes} minutes, so ORBOT stopped it`,
        p.log,
      );
    } else {
      const step = p.state.replace(/^running\s*/, '') || 'starting';
      if (step !== app.message) {
        await this.saveApp(
          supplyId,
          { ...app, message: step },
          { actor: DEPOT, reason: `${app.name} on ${s.body.name}: ${step}` },
        );
      }
    }
  }

  /** The install's state and log, read live from the server (redacted). Not recorded: a read. */
  async progress(supplyId: string, appId: string): Promise<AppProgressView> {
    const s = await this.servers.require(supplyId);
    const app = this.findApp(s, appId);
    const action: Action =
      app.status === 'removing' || app.status === 'removed' ? 'uninstall' : 'install';
    const unit = `orbot-app-${app.app}-${action}`;
    const r = await this.servers.admin(
      s,
      `sudo -n sh -c 'cat /var/lib/orbot/apps/${app.app}/state 2>/dev/null || echo missing; echo ---orbot---; systemctl is-active ${unit} 2>/dev/null; echo ---orbot---; tail -n 80 /var/log/orbot/${app.app}-${action}.log 2>/dev/null'`,
      DEPOT,
      { record: false, timeoutMs: 60_000 },
    );
    const parts = r.output.split('---orbot---');
    if (r.exitCode !== 0 || parts.length < 3) {
      return { state: 'unreachable', active: false, log: r.output.trim() };
    }
    return {
      state: parts[0]!.trim(),
      active: parts[1]!.trim() === 'active' || parts[1]!.trim() === 'activating',
      log: parts[2]!.replace(/^\n/, '').trimEnd(),
    };
  }

  /** Run the app's status.sh and keep its report. */
  async status(supplyId: string, appId: string, ctx: WriteContext) {
    const s = await this.servers.require(supplyId);
    const app = this.findApp(s, appId);
    const r = await this.servers.admin(
      s,
      `sudo -n /bin/bash /opt/orbot/apps/${app.app}/status.sh`,
      ctx.actor,
      {
        timeoutMs: 60_000,
      },
    );
    if (r.exitCode !== 0) {
      throw new BadRequestException({
        message: `Could not read ${app.name}'s status on ${s.body.name}: ${this.servers.firstLine(r.output)}`,
        action: this.servers.failureHelp(r.output, s),
      });
    }
    return this.saveApp(supplyId, { ...app, report: parseKv(r.output) }, ctx);
  }

  private async installed(s: Server, app: ServerApp, m: AppManifest, log: string) {
    const r = await this.servers.admin(
      s,
      `sudo -n /bin/bash /opt/orbot/apps/${m.id}/status.sh`,
      DEPOT,
      {
        timeoutMs: 60_000,
      },
    );
    const report = r.exitCode === 0 ? parseKv(r.output) : app.report;
    let provides = app.provides;
    let message: string | null = null;
    if (m.provides) {
      const model = await this.provideModel(s, app, m);
      provides = [model.entityId];
      const check = await this.checkModel(model.entityId, DEPOT);
      if (!check.ok) {
        message = `installed, but ORBOT cannot reach it: ${check.message}`;
      }
    }
    await this.saveApp(
      s.entityId,
      {
        ...app,
        status: 'running',
        message,
        finishedAt: new Date().toISOString(),
        provides,
        report,
      },
      { actor: DEPOT, reason: `${app.name} installed on ${s.body.name}` },
    );
    await this.event(s, app, 'installed', message, log, DEPOT);
  }

  /** The model an app serves, as a depot item: created once, then kept up to date. */
  private async provideModel(s: Server, app: ServerApp, m: AppManifest) {
    const p = m.provides!;
    const fill = (t: string) =>
      t.replace(/\{([A-Za-z_]+)\}/g, (_, k: string) =>
        k === 'host' ? s.body.spec.server.host : String(app.settings[k] ?? ''),
      );
    const ctxValue = p.contextWindow ? Number(app.settings[p.contextWindow]) : NaN;
    const spec: ModelSupply = {
      kind: 'model',
      protocol: p.protocol,
      baseUrl: fill(p.baseUrl),
      model: fill(p.model),
      credentialName: p.apiKey ? (app.credentials[p.apiKey] ?? null) : null,
      contextWindow: Number.isInteger(ctxValue) && ctxValue > 0 ? ctxValue : null,
      hostedOn: { supplyId: s.entityId, appId: app.id },
    };
    const body: SupplyBody = { name: `${spec.model} on ${s.body.name}`, connected: true, spec };
    const ctx = { actor: DEPOT, reason: `${app.name} on ${s.body.name} serves ${spec.model}` };
    const current = app.provides[0] ? await this.record.getActive('supply', app.provides[0]) : null;
    return current
      ? this.record.revise('supply', current.entityId, () => body, ctx)
      : this.record.create('supply', body, ctx);
  }

  private async finish(
    supplyId: string,
    appId: string,
    action: Action,
    status: 'failed' | 'removed',
    message: string | null,
    log: string,
  ) {
    const s = await this.servers.require(supplyId);
    const app = this.findApp(s, appId);
    const reason =
      status === 'removed'
        ? `${app.name} removed from ${s.body.name}`
        : `${app.name} ${action === 'install' ? 'install' : 'removal'} failed on ${s.body.name}`;
    await this.saveApp(
      supplyId,
      { ...app, status, message, finishedAt: new Date().toISOString() },
      { actor: DEPOT, reason },
    );
    if (status === 'removed') {
      // What it provided can no longer be reached; the items stay (nothing is deleted).
      for (const id of app.provides) {
        await this.record.revise('supply', id, (b) => ({ ...b, connected: false }), {
          actor: DEPOT,
          reason,
        });
      }
    }
    await this.event(s, app, status, message, log, DEPOT);
  }

  // ---------- Models ----------

  /** Ask a model endpoint which models it serves, with its key (used by name, recorded). */
  async checkModel(supplyId: string, actor: string): Promise<ModelCheckView> {
    const m = await this.record.requireActive('supply', supplyId);
    if (m.body.spec.kind !== 'model') {
      throw new BadRequestException({
        message: `${m.body.name} is not a model.`,
        action: 'Choose a model.',
      });
    }
    const spec = m.body.spec;
    const headers: Record<string, string> = {};
    if (spec.credentialName) {
      headers['authorization'] = `Bearer ${await this.secrets.reveal(spec.credentialName)}`;
      await this.record.event(
        'credential.used',
        { secretName: spec.credentialName, purpose: `ask ${spec.baseUrl} which models it serves` },
        {},
        actor,
      );
    }
    try {
      const res = await fetch(`${spec.baseUrl.replace(/\/$/, '')}/models`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { ok: false, models: [], message: `${spec.baseUrl} answered ${res.status}.` };
      }
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      const models = (body.data ?? []).map((d) => String(d.id ?? '')).filter(Boolean);
      const ok = models.includes(spec.model);
      return {
        ok,
        models,
        message: ok
          ? `${spec.model} answers at ${spec.baseUrl}.`
          : `${spec.baseUrl} serves ${models.join(', ') || 'nothing'}, not ${spec.model}.`,
      };
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      return {
        ok: false,
        models: [],
        message: this.redaction.clean(
          `no answer from ${spec.baseUrl} (${cause ?? (err as Error).message}). Check the listen address and any firewall between here and the server.`,
        ),
      };
    }
  }

  // ---------- Helpers ----------

  private findApp(s: Server, appId: string): ServerApp {
    const app = s.body.spec.server.apps.find((a) => a.id === appId);
    if (!app) {
      throw new NotFoundException({
        message: `No app ${appId} on ${s.body.name}.`,
        action: 'Open the server’s page to see what is installed.',
      });
    }
    return app;
  }

  private saveApp(supplyId: string, app: ServerApp, ctx: WriteContext) {
    return this.servers.reviseServer(
      supplyId,
      (sv) => ({
        ...sv,
        apps: sv.apps.some((a) => a.id === app.id)
          ? sv.apps.map((a) => (a.id === app.id ? app : a))
          : [...sv.apps, app],
      }),
      ctx,
    );
  }

  private event(
    s: Server,
    app: ServerApp,
    status: 'started' | 'installed' | 'failed' | 'removed',
    message: string | null,
    log: string,
    actor: string,
  ) {
    return this.record.event(
      'app.install',
      {
        supplyId: s.entityId,
        server: s.body.name,
        app: app.name,
        appId: app.id,
        status,
        message,
        log: tail(this.redaction.clean(log), RECORD_LOG),
      },
      {},
      actor,
    );
  }
}
