import { Injectable } from '@nestjs/common';
import type { RecordEvent, ServiceRecordView } from '@orbot/shared';
import { RecordService } from '../record/record.service.js';
import { toView } from './view.js';

const KINDS = [
  'run.started',
  'run.finished',
  'cost',
  'diary.entry',
  'sitrep',
  'report.filed',
  'dispute.raised',
  'escalation',
  'policy.check',
  'stand-down',
  'stand-down.lifted',
  'task.status',
] as const;

/**
 * A bot's service record: what it has done and how, worked out from the permanent record
 * (runs and their outcomes, spend, handovers, refusals, escalations, and the Field Manual
 * entries that came from its handovers). It is about the bot's conduct, not knowledge:
 * it never goes into a brief (principle 3), and it outlives the bot's active service.
 */
@Injectable()
export class ServiceRecordService {
  constructor(private readonly record: RecordService) {}

  async forBot(botId: string): Promise<ServiceRecordView> {
    const bot = await this.record.requireActive('bot', botId);
    const actor = `bot:${botId}`;
    const [unit, history, events, handovers, bots, entries, tasks] = await Promise.all([
      this.record.getActive('unit', bot.body.unitId),
      this.record.history(botId),
      this.record.listEvents({ botId, kinds: [...KINDS], limit: 100_000 }),
      this.record.listActive('document', { bodyContains: { kind: 'handover', botId } }),
      this.record.listActive('bot', { unitId: bot.body.unitId }),
      this.record.listActive('fm-entry', { unitId: bot.body.unitId }),
      this.record.listActive('task', { bodyContains: { botId } }),
    ]);
    const of = <K extends (typeof KINDS)[number]>(k: K) =>
      events.filter((e) => e.kind === k) as RecordEvent<K>[];
    // Only what the bot itself did (sitreps and stand-downs can be about it, by others).
    const mine = <K extends (typeof KINDS)[number]>(k: K) => of(k).filter((e) => e.actor === actor);

    const finished = of('run.finished');
    const outcomes = { done: 0, failed: 0, blocked: 0, stopped: 0 };
    for (const f of finished) outcomes[f.body.outcome]++;
    const started = new Map(of('run.started').map((e) => [e.body.runId, e.createdAt]));
    const lengths = finished
      .map((f) => {
        const s = started.get(f.body.runId);
        return s ? (Date.parse(f.createdAt) - Date.parse(s)) / 1000 : null;
      })
      .filter((x): x is number => x !== null);
    const refusals = of('policy.check').filter((e) => !e.body.allowed && e.actor === actor);
    const handoverIds = new Set(handovers.map((h) => h.entityId));
    const commendations = entries
      .filter((e) =>
        e.body.sources.some((s) => s.kind === 'handover' && s.id && handoverIds.has(s.id)),
      )
      .map((e) => ({
        entryId: e.entityId,
        title: e.body.title,
        at: e.createdAt,
        retired: e.body.retired,
      }));

    const first = history[0]!;
    const replaces = bot.body.replacesBotId
      ? await this.record.getActive('bot', bot.body.replacesBotId)
      : null;
    const replacedBy = bots.find((b) => b.body.replacesBotId === botId) ?? null;
    const unitLink = `/units/${bot.body.unitId}`;
    const taskLink = (taskId: string | null) =>
      taskId ? `${unitLink}/bots/${botId}/tasks/${taskId}` : null;

    const notable: ServiceRecordView['entries'] = [
      {
        at: first.createdAt,
        kind: 'enlisted',
        text: `Joined ${unit?.body.name ?? 'the unit'} as ${bot.body.role}: ${first.reason}`,
        link: null,
      },
      ...history.slice(1).flatMap((v, i) => {
        const prev = history[i]!.body as { runtime?: string };
        const cur = v.body as { runtime?: string };
        return prev.runtime !== cur.runtime
          ? [
              {
                at: v.createdAt,
                kind: 'runtime',
                text: `Runtime ${prev.runtime} → ${cur.runtime}: ${v.reason}`,
                link: null,
              },
            ]
          : [];
      }),
      ...of('task.status')
        .filter((e) => e.body.to === 'done' || e.body.to === 'failed')
        .map((e) => {
          const t = tasks.find((x) => x.entityId === e.taskId);
          return {
            at: e.createdAt,
            kind: e.body.to,
            text: `Task #${t?.body.number ?? '?'} ${t?.body.title ?? ''} — ${e.body.to}${e.body.reason ? `: ${e.body.reason}` : ''}`,
            link: taskLink(e.taskId),
          };
        }),
      ...of('escalation').map((e) => ({
        at: e.createdAt,
        kind: 'escalation',
        text: `Escalated to ${e.body.level}: ${e.body.text}`,
        link: taskLink(e.taskId),
      })),
      ...mine('dispute.raised').map((e) => ({
        at: e.createdAt,
        kind: 'dispute',
        text: `Disputed with ${e.body.against}: ${e.body.claim}`,
        link: taskLink(e.taskId),
      })),
      ...refusals.map((e) => ({
        at: e.createdAt,
        kind: 'refusal',
        text: `Refused (${e.body.action}): ${e.body.reason}`,
        link: taskLink(e.taskId),
      })),
      ...of('stand-down')
        .filter((e) => e.body.scope === 'bot')
        .map((e) => ({
          at: e.createdAt,
          kind: 'stood-down',
          text: `Stood down: ${e.body.reason}`,
          link: null,
        })),
      ...commendations.map((c) => ({
        at: c.at,
        kind: 'commendation',
        text: `Its handover became a Field Manual entry: “${c.title}”`,
        link: `${unitLink}?section=field-manual`,
      })),
    ].sort((a, b) => b.at.localeCompare(a.at));

    const ended = outcomes.done + outcomes.failed + outcomes.blocked;
    return {
      bot: toView(bot),
      unitName: unit?.body.name ?? '',
      enlisted: { at: first.createdAt, by: first.actor, reason: first.reason },
      replaces: replaces ? { id: replaces.entityId, callsign: replaces.body.callsign } : null,
      replacedBy: replacedBy
        ? { id: replacedBy.entityId, callsign: replacedBy.body.callsign }
        : null,
      stats: {
        runs: finished.length,
        outcomes,
        tasksDone: tasks.filter((t) => t.body.status === 'done').length,
        successRate: ended ? outcomes.done / ended : null,
        averageRunSeconds: lengths.length
          ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)
          : null,
        unitsSpent: of('cost').reduce((n, e) => n + e.body.units, 0),
        handovers: handovers.length,
        diaryEntries: mine('diary.entry').length,
        sitreps: mine('sitrep').length,
        reports: mine('report.filed').length,
        disputesRaised: mine('dispute.raised').length,
        escalations: of('escalation').length,
        refusals: refusals.length,
      },
      commendations,
      entries: notable.slice(0, 60),
    };
  }
}
