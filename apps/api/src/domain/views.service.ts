import { Inject, Injectable } from '@nestjs/common';
import type {
  AttentionItem,
  BotDetailView,
  BotStatus,
  BotView,
  MissionView,
  OrbatUnit,
  OrbatView,
  Status,
  TaskDetailView,
  TaskView,
  UnitDetailView,
} from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { RecordService } from '../record/record.service.js';
import { toView, toViews } from './view.js';

const unitLink = (unitId: string) => `/units/${unitId}`;
const botLink = (unitId: string, botId: string) => `/units/${unitId}/bots/${botId}`;
const taskLink = (unitId: string, botId: string | null, taskId: string) =>
  botId ? `${botLink(unitId, botId)}/tasks/${taskId}` : `${unitLink(unitId)}/tasks/${taskId}`;

/** Read models for the screens. Built from the active tier of the record. */
@Injectable()
export class ViewsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
  ) {}

  async orbat(): Promise<OrbatView> {
    const [units, bots, tasks, missions] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('task'),
      this.record.listActive('mission'),
    ]);
    const out: OrbatUnit[] = units
      .sort((a, b) => a.body.order - b.body.order)
      .map((u) => {
        const ub = bots.filter((b) => b.body.unitId === u.entityId).map(toView);
        const ut = tasks.filter((t) => t.body.unitId === u.entityId).map(toView);
        const um = missions.filter((m) => m.body.unitId === u.entityId).map(toView);
        const botsByStatus: Partial<Record<BotStatus, number>> = {};
        for (const b of ub.filter((b) => !b.isOverseer))
          botsByStatus[b.status] = (botsByStatus[b.status] ?? 0) + 1;
        const attention = attentionFor(u.entityId, ub, ut, um);
        return {
          unit: toView(u),
          overseer: ub.find((b) => b.id === u.body.overseerBotId) ?? null,
          botCount: ub.filter((b) => !b.isOverseer).length,
          botsByStatus,
          currentMission: um.find((m) => m.status !== 'done') ?? null,
          status: unitStatus(ub, ut),
          attention,
        };
      });
    return {
      productName: this.config.productName,
      units: out,
      needsYou: out.reduce((n, u) => n + u.attention.length, 0),
    };
  }

  async unit(id: string): Promise<UnitDetailView> {
    const u = await this.record.requireActive('unit', id);
    const [bots, tasks, missions, documents, supply] = await Promise.all([
      this.record.listActive('bot', { unitId: id }),
      this.record.listActive('task', { unitId: id }),
      this.record.listActive('mission', { unitId: id }),
      this.record.listActive('document', { unitId: id }),
      this.record.listActive('supply'),
    ]);
    const bv = toViews(bots).sort(byCallsign);
    const tv = toViews(tasks).sort((a, b) => b.number - a.number);
    const mv = toViews(missions);
    return {
      unit: toView(u),
      status: unitStatus(bv, tv),
      overseer: bv.find((b) => b.id === u.body.overseerBotId) ?? null,
      bots: bv.map((b) => ({
        ...b,
        currentTask: tv.find((t) => t.id === b.currentTaskId) ?? null,
      })),
      missions: mv,
      tasks: tv,
      documents: toViews(documents.filter((d) => d.body.kind !== 'handover')).concat(
        toViews(documents.filter((d) => d.body.kind === 'handover')),
      ),
      supply: toViews(supply.filter((s) => u.body.supplyIds.includes(s.entityId))),
      attention: attentionFor(id, bv, tv, mv),
    };
  }

  async bot(id: string): Promise<BotDetailView> {
    const b = await this.record.requireActive('bot', id);
    const [unit, tasks, recent] = await Promise.all([
      this.record.requireActive('unit', b.body.unitId),
      this.record.listActive('task', { bodyContains: { botId: id } }),
      this.record.listEvents({ botId: id, limit: 1000 }),
    ]);
    const tv = toViews(tasks);
    return {
      bot: toView(b),
      unit: toView(unit),
      currentTask: tv.find((t) => t.id === b.body.currentTaskId) ?? null,
      queue: b.body.queue.map((q) => tv.find((t) => t.id === q)).filter((t): t is TaskView => !!t),
      history: tv
        .filter((t) => t.id !== b.body.currentTaskId && !b.body.queue.includes(t.id))
        .sort((x, y) => y.number - x.number),
      recent: recent.slice(-50).reverse(),
    };
  }

  async task(id: string): Promise<TaskDetailView> {
    const t = await this.record.requireActive('task', id);
    const [unit, bot, mission, events, versions, handovers] = await Promise.all([
      this.record.requireActive('unit', t.body.unitId),
      t.body.botId ? this.record.getActive('bot', t.body.botId) : null,
      t.body.missionId ? this.record.getActive('mission', t.body.missionId) : null,
      this.record.listEvents({ taskId: id, limit: 1000 }),
      this.record.history(id),
      this.record.listActive('document', { bodyContains: { kind: 'handover', taskId: id } }),
    ]);
    return {
      task: toView(t),
      unit: toView(unit),
      bot: bot ? toView(bot) : null,
      mission: mission ? toView(mission) : null,
      events,
      versions,
      handover: handovers[0] ? toView(handovers[0]) : null,
    };
  }
}

function byCallsign(a: BotView, b: BotView) {
  if (a.isOverseer !== b.isOverseer) return a.isOverseer ? -1 : 1;
  return a.callsign.localeCompare(b.callsign, undefined, { numeric: true });
}

function unitStatus(bots: BotView[], tasks: TaskView[]): Status {
  if (tasks.some((t) => t.status === 'failed') || bots.some((b) => b.status === 'failed'))
    return 'failed';
  if (bots.some((b) => b.status === 'blocked') || tasks.some((t) => t.status === 'blocked'))
    return 'blocked';
  if (tasks.some((t) => t.status === 'awaiting-approval')) return 'awaiting-approval';
  if (bots.some((b) => b.status === 'working')) return 'working';
  if (bots.length && bots.every((b) => b.status === 'stood-down')) return 'stood-down';
  return 'idle';
}

function attentionFor(
  unitId: string,
  bots: BotView[],
  tasks: TaskView[],
  missions: MissionView[],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const b of bots.filter((b) => b.status === 'blocked')) {
    const t = tasks.find((x) => x.id === b.currentTaskId);
    items.push({
      kind: 'blocked-bot',
      label: t
        ? `${b.callsign} blocked on #${t.number}: ${t.statusReason ?? 'no reason given'}`
        : `${b.callsign} is blocked`,
      link: t ? taskLink(unitId, b.id, t.id) : botLink(unitId, b.id),
      entityId: b.id,
    });
  }
  for (const t of tasks.filter((t) => t.status === 'failed')) {
    items.push({
      kind: 'failed-task',
      label: `Task #${t.number} failed: ${t.statusReason ?? t.title}`,
      link: taskLink(unitId, t.botId, t.id),
      entityId: t.id,
    });
  }
  for (const m of missions.filter((m) => m.status === 'awaiting-approval')) {
    items.push({
      kind: 'awaiting-approval',
      label: `Backbrief awaiting approval: ${m.goal}`,
      link: unitLink(unitId),
      entityId: m.id,
    });
  }
  for (const t of tasks.filter((t) => t.status === 'awaiting-approval')) {
    items.push({
      kind: 'awaiting-approval',
      label: `Task #${t.number} awaiting approval`,
      link: taskLink(unitId, t.botId, t.id),
      entityId: t.id,
    });
  }
  return items;
}
