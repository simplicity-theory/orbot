import {
  BadRequestException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { STATUS_META, type DailyBriefView, type RecordEvent } from '@orbot/shared';
import { Background } from '../common/background.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { toView } from '../domain/view.js';
import { ViewsService } from '../domain/views.service.js';
import { RecordService } from '../record/record.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { HQ_ACTOR } from './overseers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The local date (YYYY-MM-DD) and time (HH:MM) of an instant in a time zone. */
export function localParts(at: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, time: `${p('hour')}:${p('minute')}` };
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The daily brief: once a day, at the time in Settings, HQ writes the Commander a brief.
 * What needs you, each operation and unit, what it cost, what happened and what was
 * learned. One document per day (`daily-brief`); writing it again that day makes a new
 * version, and every earlier brief is kept.
 */
@Injectable()
export class DailyBriefService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly settings: SettingsService,
    private readonly views: ViewsService,
    private readonly background: Background,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.dailyBriefCheckMs > 0) {
      this.timer = setInterval(
        () => this.background.run('hq:daily-brief', 'daily-brief', () => this.writeIfDue()),
        this.config.dailyBriefCheckMs,
      );
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Write today's brief if it is time and it isn't written yet. */
  async writeIfDue(now = new Date()): Promise<boolean> {
    const s = (await this.settings.get()).dailyBrief;
    if (!s?.enabled || !validTimeZone(s.timeZone)) return false;
    const { date, time } = localParts(now, s.timeZone);
    if (time < s.at) return false;
    if (await this.forDate(date)) return false;
    await this.write(HQ_ACTOR, now);
    return true;
  }

  async view(now = new Date()): Promise<DailyBriefView> {
    const docs = (
      await this.record.listActive('document', { bodyContains: { kind: 'daily-brief' } })
    ).sort((a, b) => b.body.title.localeCompare(a.body.title));
    const s = (await this.settings.get()).dailyBrief;
    return {
      latest: docs[0] ? toView(docs[0]) : null,
      earlier: docs
        .slice(1)
        .map((d) => ({ id: d.entityId, title: d.body.title, createdAt: d.createdAt })),
      nextAt: s?.enabled && validTimeZone(s.timeZone) ? this.nextAt(now, s.at, s.timeZone) : null,
    };
  }

  /** Write (or rewrite) today's brief now. */
  async write(actor: string, now = new Date()) {
    const s = (await this.settings.get()).dailyBrief;
    const tz = s && validTimeZone(s.timeZone) ? s.timeZone : 'UTC';
    if (s && !validTimeZone(s.timeZone)) {
      throw new BadRequestException({
        message: `“${s.timeZone}” is not a time zone.`,
        action: 'Set the daily brief time zone in Settings (for example Europe/London).',
      });
    }
    const { date, time } = localParts(now, tz);
    const title = `Daily brief — ${date}`;
    const markdown = await this.compose(title, `${time} (${tz})`, now);
    const existing = await this.forDate(date);
    const ctx = { actor, reason: existing ? 'Daily brief rewritten' : 'Daily brief' };
    const doc = existing
      ? await this.record.revise('document', existing.entityId, (d) => ({ ...d, markdown }), ctx)
      : await this.record.create(
          'document',
          {
            kind: 'daily-brief',
            unitId: null,
            title,
            markdown,
            taskId: null,
            botId: null,
            operationId: null,
          },
          ctx,
        );
    return doc;
  }

  private async forDate(date: string) {
    const [doc] = await this.record.listActive('document', {
      bodyContains: { kind: 'daily-brief', title: `Daily brief — ${date}` },
    });
    return doc ?? null;
  }

  /** The next time the brief is due, as an ISO instant (found minute by minute; a day at most). */
  private nextAt(now: Date, at: string, tz: string): string {
    const start = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
    for (let m = 0; m <= 24 * 60; m++) {
      const t = new Date(start.getTime() + m * 60_000);
      if (localParts(t, tz).time === at) return t.toISOString();
    }
    return start.toISOString();
  }

  private async compose(title: string, writtenAt: string, now: Date): Promise<string> {
    const from = new Date(now.getTime() - DAY_MS).toISOString();
    const [approvals, ops, orbat, events, settings] = await Promise.all([
      this.views.approvals(),
      this.views.operations(),
      this.views.orbat(),
      this.record.listEvents(
        {
          kinds: [
            'task.status',
            'sitrep',
            'escalation',
            'escalation.resolved',
            'deployment',
            'stand-down',
            'cost',
            'report.filed',
          ],
          limit: 5000,
        },
        { from },
      ),
      this.settings.get(),
    ]);
    const of = <K extends RecordEvent['kind']>(k: K) =>
      events.filter((e) => e.kind === k) as RecordEvent<K>[];
    const statuses = of('task.status');
    const count = (to: string, unitId?: string) =>
      statuses.filter((e) => e.body.to === to && (!unitId || e.unitId === unitId)).length;
    const spent = (unitId?: string) =>
      of('cost')
        .filter((e) => !unitId || e.unitId === unitId)
        .reduce((n, e) => n + e.body.units, 0);

    const needs = [
      ...approvals.backbriefs.map(
        (b) => `- Backbrief to approve: ${b.unitName} — ${b.mission.goal}`,
      ),
      ...approvals.attention
        .filter((a) => a.kind !== 'awaiting-approval' || !a.link.startsWith('/approvals'))
        .map((a) => `- ${a.label} (${a.unitName})`),
      ...ops.flatMap((o) =>
        o.needsYou.filter((n) => n.kind === 'sand-table').map((n) => `- ${n.label}`),
      ),
    ];
    const me = settings.mainEffort?.operationId;
    const opLines = ops
      .filter((o) => o.operation.phase !== 'closed')
      .map((o) => {
        const done = o.missions.reduce((n, m) => n + m.done, 0);
        const total = o.missions.reduce((n, m) => n + m.total, 0);
        return `- **Operation ${o.operation.name}**${o.operation.id === me ? ' (main effort)' : ''} — ${o.operation.phase}; ${done}/${total} tasks done; ${o.budget.spent} units spent${o.budget.cap !== null ? ` of ${o.budget.cap}` : ''}.`;
      });
    const unitRows = orbat.units.map((u) => {
      const id = u.unit.id;
      const cap = u.budget.cap !== null ? `${u.budget.spent}/${u.budget.cap}` : `${u.budget.spent}`;
      return `| ${u.unit.name} | ${STATUS_META[u.status].label} | ${count('done', id)} | ${count('failed', id)} | ${count('blocked', id)} | ${spent(id)} | ${cap} |`;
    });
    const happened = [
      ...of('deployment').map(
        (e) => `- Deployed to ${e.body.environment} (${e.body.commit.slice(0, 10)}).`,
      ),
      ...of('escalation')
        .filter((e) => e.body.level === 'commander')
        .map((e) => `- Escalated to you: ${e.body.text}`),
      ...of('stand-down').map((e) => `- Stand-down order: ${e.body.reason}.`),
      ...of('sitrep')
        .filter((e) => e.body.level === 'hq')
        .slice(-8)
        .map((e) => `- HQ: ${e.body.text}`),
    ];
    const lessons = (await this.record.listActive('fm-entry'))
      .filter((e) => e.createdAt >= from)
      .map((e) => {
        const unit = orbat.units.find((u) => u.unit.id === e.body.unitId)?.unit.name;
        return `- ${unit ? `${unit}: ` : ''}${e.body.title}`;
      });
    const reports = of('report.filed').map((e) => `- ${e.body.title}`);
    const queued = orbat.units.reduce(
      (n, u) => n + u.bots.reduce((m, b) => m + b.queue.length, 0),
      0,
    );
    const section = (h: string, lines: string[], none: string) =>
      [`## ${h}`, lines.length ? lines.join('\n') : `- ${none}`, ''].join('\n');

    return [
      `# ${title}`,
      '',
      `_Written by HQ at ${writtenAt}. Covers the last 24 hours._`,
      '',
      `**${count('done')}** task(s) done, **${count('failed')}** failed, **${count('blocked')}** blocked; **${spent()}** compute units spent. **${needs.length}** thing(s) need you.`,
      '',
      section(`Needs you (${needs.length})`, needs, 'Nothing is waiting on you.'),
      section('Operations', opLines, 'No operation under way.'),
      '## Units',
      '| Unit | Status | Done | Failed | Blocked | Spent | Budget |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...unitRows,
      '',
      section('What happened', happened, 'Nothing of note.'),
      section('Learned', [...lessons, ...reports], 'No new Field Manual entries or recon reports.'),
      section(
        'Next',
        [
          `- ${queued} task(s) queued.`,
          me
            ? `- Main effort: ${ops.find((o) => o.operation.id === me)?.operation.name ?? 'an operation'}.`
            : '- No main effort named.',
        ],
        '',
      ),
    ].join('\n');
  }
}
