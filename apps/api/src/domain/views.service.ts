import { Inject, Injectable } from '@nestjs/common';
import type {
  ApprovalsView,
  AttentionItem,
  BackbriefBody,
  BackbriefView,
  BotBody,
  BotDetailView,
  BotStatus,
  BotView,
  MissionBody,
  MissionProgress,
  MissionView,
  OperationDetailView,
  OperationSummary,
  OrbatUnit,
  OrbatView,
  PaletteItem,
  RecordEvent,
  RecordVersion,
  Status,
  TaskDetailView,
  TaskView,
  UnitBody,
  UnitDetailView,
} from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { FieldManualService } from '../documents/field-manual.service.js';
import { UnitDocsService } from '../documents/unit-docs.service.js';
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
    private readonly fieldManual: FieldManualService,
    private readonly docs: UnitDocsService,
  ) {}

  async orbat(): Promise<OrbatView> {
    const [units, bots, tasks, missions, backbriefs] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('task'),
      this.record.listActive('mission'),
      this.record.listActive('backbrief', { bodyContains: { status: 'awaiting-approval' } }),
    ]);
    const bbViews = backbriefViews(backbriefs, missions, units, bots);
    const out: OrbatUnit[] = units
      .sort((a, b) => a.body.order - b.body.order)
      .map((u) => {
        const ub = bots.filter((b) => b.body.unitId === u.entityId).map(toView);
        const ut = tasks.filter((t) => t.body.unitId === u.entityId).map(toView);
        const um = missions.filter((m) => m.body.unitId === u.entityId).map(toView);
        const ubb = bbViews.filter((b) => b.unitId === u.entityId);
        const botsByStatus: Partial<Record<BotStatus, number>> = {};
        for (const b of ub.filter((b) => !b.isOverseer && b.status !== 'stood-down')) {
          botsByStatus[b.status] = (botsByStatus[b.status] ?? 0) + 1;
        }
        return {
          unit: toView(u),
          overseer: ub.find((b) => b.id === u.body.overseerBotId) ?? null,
          botCount: ub.filter((b) => !b.isOverseer && b.status !== 'stood-down').length,
          botsByStatus,
          currentMission: um.find((m) => m.status !== 'done') ?? null,
          status: unitStatus(ub, ut, ubb),
          attention: attentionFor(u.entityId, ub, ut, ubb),
          backbriefs: ubb,
          bots: ub
            .filter((b) => !b.isOverseer)
            .sort(byCallsign)
            .map((b) => ({ ...b, currentTask: ut.find((t) => t.id === b.currentTaskId) ?? null })),
        };
      });
    return {
      productName: this.config.productName,
      units: out,
      needsYou: out.reduce((n, u) => n + u.attention.length, 0),
    };
  }

  /** The single inbox: backbriefs to decide, plus everything else waiting on the Commander. */
  async approvals(): Promise<ApprovalsView> {
    const orbat = await this.orbat();
    return {
      backbriefs: orbat.units.flatMap((u) => u.backbriefs),
      attention: orbat.units.flatMap((u) =>
        u.attention.map((a) => ({ ...a, unitName: u.unit.name })),
      ),
    };
  }

  async unit(id: string): Promise<UnitDetailView> {
    const u = await this.record.requireActive('unit', id);
    const [
      bots,
      tasks,
      missions,
      documents,
      supply,
      backbriefs,
      entries,
      retired,
      warDiary,
      coldStart,
      docsMirror,
    ] = await Promise.all([
      this.record.listActive('bot', { unitId: id }),
      this.record.listActive('task', { unitId: id }),
      this.record.listActive('mission', { unitId: id }),
      this.record.listActive('document', { unitId: id }),
      this.record.listActive('supply'),
      this.record.listActive('backbrief', { unitId: id }),
      this.fieldManual.entries(id),
      this.fieldManual.entries(id, { retired: true }),
      this.record.listEvents({ unitId: id, kinds: ['diary.entry'], limit: 500 }, { latest: true }),
      this.record.listEvents(
        { unitId: id, kinds: ['coldstart.check'], limit: 1 },
        { latest: true },
      ),
      this.docs.describe(id),
    ]);
    const bv = toViews(bots).sort(byCallsign);
    const tv = toViews(tasks).sort((a, b) => b.number - a.number);
    const bbViews = backbriefViews(backbriefs, missions, [u], bots);
    const awaiting = bbViews.filter((b) => b.status === 'awaiting-approval');
    const progress: MissionProgress[] = toViews(missions)
      .map((m) => {
        const mt = tv.filter((t) => t.missionId === m.id);
        return {
          mission: m,
          done: mt.filter((t) => t.status === 'done').length,
          total: mt.length,
          backbrief: bbViews.find((b) => b.missionId === m.id) ?? null,
        };
      })
      .sort((a, b) => Number(a.mission.status === 'done') - Number(b.mission.status === 'done'));
    const queue = bv
      .filter((b) => !b.isOverseer)
      .flatMap((b) =>
        b.queue.map((q) => tv.find((t) => t.id === q)).filter((t): t is TaskView => !!t),
      );
    return {
      unit: toView(u),
      status: unitStatus(bv, tv, awaiting),
      overseer: bv.find((b) => b.id === u.body.overseerBotId) ?? null,
      bots: bv.map((b) => ({
        ...b,
        currentTask: tv.find((t) => t.id === b.currentTaskId) ?? null,
      })),
      missions: progress,
      tasks: tv,
      queue,
      documents: toViews(documents.filter((d) => d.body.kind !== 'handover')),
      handovers: toViews(documents.filter((d) => d.body.kind === 'handover')).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
      fieldManual: toViews(entries),
      retiredEntries: toViews(retired),
      warDiary: [...warDiary].reverse(),
      supply: toViews(supply.filter((s) => u.body.supplyIds.includes(s.entityId))),
      attention: attentionFor(id, bv, tv, awaiting),
      backbriefs: awaiting,
      coldStart: (coldStart[0] as RecordEvent<'coldstart.check'> | undefined) ?? null,
      docsMirror,
    };
  }

  async bot(id: string): Promise<BotDetailView> {
    const b = await this.record.requireActive('bot', id);
    const [unit, tasks, recent, briefs, peers] = await Promise.all([
      this.record.requireActive('unit', b.body.unitId),
      this.record.listActive('task', { bodyContains: { botId: id } }),
      this.record.listEvents({ botId: id, limit: 50 }, { latest: true }),
      this.record.listEvents({ botId: id, kinds: ['task.briefed'], limit: 1 }, { latest: true }),
      this.record.listActive('bot', { unitId: b.body.unitId }),
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
      recent: [...recent].reverse(),
      lastBrief: (briefs[0] as RecordEvent<'task.briefed'> | undefined) ?? null,
      peers: toViews(peers)
        .filter((p) => p.id !== id && !p.isOverseer && p.status !== 'stood-down')
        .sort(byCallsign),
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

  async backbrief(id: string): Promise<BackbriefView> {
    const bb = await this.record.requireActive('backbrief', id);
    const [missions, units, bots] = await Promise.all([
      this.record.listActive('mission', { unitId: bb.body.unitId }),
      this.record.listActive('unit'),
      this.record.listActive('bot', { unitId: bb.body.unitId }),
    ]);
    return backbriefViews([bb], missions, units, bots)[0]!;
  }

  async operations(): Promise<OperationSummary[]> {
    const ops = await this.record.listActive('operation');
    return Promise.all(
      ops
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((o) => this.operationSummary(o.entityId)),
    );
  }

  async operationSummary(id: string): Promise<OperationSummary> {
    const op = await this.record.requireActive('operation', id);
    const [units, bots, missions, tasks, backbriefs] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('mission', { bodyContains: { operationId: id } }),
      this.record.listActive('task'),
      this.record.listActive('backbrief'),
    ]);
    const order = op.body.missionIds.length ? op.body.missionIds : missions.map((m) => m.entityId);
    const bbViews = backbriefViews(
      backbriefs.filter((b) => order.includes(b.body.missionId)),
      missions,
      units,
      bots,
    );
    const rows = order.flatMap((mid) => {
      const m = missions.find((x) => x.entityId === mid);
      const u = m && units.find((x) => x.entityId === m.body.unitId);
      if (!m || !u) return [];
      const mt = toViews(tasks.filter((t) => t.body.missionId === mid));
      return [
        {
          mission: toView(m),
          unit: toView(u),
          done: mt.filter((t) => t.status === 'done').length,
          total: mt.length,
          tasks: mt,
          backbrief: bbViews.find((b) => b.missionId === mid) ?? null,
        },
      ];
    });
    const needsYou = rows.flatMap((r) => [
      ...(r.backbrief?.status === 'awaiting-approval'
        ? [
            {
              kind: 'awaiting-approval' as const,
              label: `${r.unit.name} backbrief awaiting approval`,
              link: `/operations/${id}`,
              entityId: r.backbrief.id,
            },
          ]
        : []),
      ...attentionFor(
        r.unit.id,
        toViews(bots.filter((b) => b.body.unitId === r.unit.id)),
        r.tasks,
        [],
      ),
    ]);
    return { operation: toView(op), missions: rows, needsYou };
  }

  async operation(id: string): Promise<OperationDetailView> {
    const summary = await this.operationSummary(id);
    const op = summary.operation;
    const [timeline, record, aar] = await Promise.all([
      this.record.listEvents({
        operationId: id,
        kinds: [
          'operation.phase',
          'handoff',
          'sendback',
          'integration',
          'deployment',
          'sitrep',
          'deploy.approval',
          'after-action',
        ],
        limit: 1000,
      }),
      op.recordDocumentId ? this.record.getActive('document', op.recordDocumentId) : null,
      op.afterActionDocumentId ? this.record.getActive('document', op.afterActionDocumentId) : null,
    ]);
    return {
      ...summary,
      timeline,
      record: record ? toView(record) : null,
      afterAction: aar ? toView(aar) : null,
    };
  }

  /** Everything the command palette can jump to. */
  async palette(): Promise<PaletteItem[]> {
    const [units, bots, tasks, ops, docs, missions] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('task'),
      this.record.listActive('operation'),
      this.record.listActive('document'),
      this.record.listActive('mission'),
    ]);
    const unitName = new Map(units.map((u) => [u.entityId, u.body.name]));
    const items: PaletteItem[] = [
      ...units.map((u) => ({
        kind: 'unit' as const,
        id: u.entityId,
        label: u.body.name,
        sublabel: `Unit · ${u.body.role}`,
        link: unitLink(u.entityId),
      })),
      ...bots.map((b) => ({
        kind: 'bot' as const,
        id: b.entityId,
        label: `Bot ${b.body.callsign}`,
        sublabel: `${unitName.get(b.body.unitId) ?? ''} · ${b.body.role}`,
        link: botLink(b.body.unitId, b.entityId),
      })),
      ...tasks
        .sort((a, b) => b.body.number - a.body.number)
        .map((t) => ({
          kind: 'task' as const,
          id: t.entityId,
          label: `Task #${t.body.number}: ${t.body.title}`,
          sublabel: `${unitName.get(t.body.unitId) ?? ''} · ${t.body.status}`,
          link: taskLink(t.body.unitId, t.body.botId, t.entityId),
        })),
      ...missions.map((m) => ({
        kind: 'mission' as const,
        id: m.entityId,
        label: m.body.goal,
        sublabel: `Mission · ${unitName.get(m.body.unitId) ?? ''}`,
        link: unitLink(m.body.unitId),
      })),
      ...ops.map((o) => ({
        kind: 'operation' as const,
        id: o.entityId,
        label: `Operation ${o.body.name}`,
        sublabel: `Operation · ${o.body.phase}`,
        link: `/operations/${o.entityId}`,
      })),
      ...docs.map((d) => ({
        kind: 'document' as const,
        id: d.entityId,
        label: d.body.title,
        sublabel: `Document · ${d.body.unitId ? (unitName.get(d.body.unitId) ?? '') : 'HQ'}`,
        link: d.body.unitId
          ? `/units/${d.body.unitId}/documents/${d.entityId}`
          : `/archive/${d.entityId}`,
      })),
    ];
    return items;
  }
}

function backbriefViews(
  backbriefs: RecordVersion<BackbriefBody>[],
  missions: RecordVersion<MissionBody>[],
  units: RecordVersion<UnitBody>[],
  bots: RecordVersion<BotBody>[],
): BackbriefView[] {
  const callsigns = Object.fromEntries(bots.map((b) => [b.entityId, b.body.callsign]));
  return backbriefs.flatMap((bb) => {
    const m = missions.find((x) => x.entityId === bb.body.missionId);
    if (!m) return [];
    return [
      {
        ...toView(bb),
        mission: toView(m) as MissionView,
        unitName: units.find((u) => u.entityId === bb.body.unitId)?.body.name ?? '',
        callsigns,
      },
    ];
  });
}

function byCallsign(a: BotView, b: BotView) {
  if (a.isOverseer !== b.isOverseer) return a.isOverseer ? -1 : 1;
  return a.callsign.localeCompare(b.callsign, undefined, { numeric: true });
}

function unitStatus(bots: BotView[], tasks: TaskView[], awaiting: BackbriefView[]): Status {
  const active = bots.filter((b) => b.status !== 'stood-down');
  if (tasks.some((t) => t.status === 'failed') || active.some((b) => b.status === 'failed'))
    return 'failed';
  if (active.some((b) => b.status === 'blocked') || tasks.some((t) => t.status === 'blocked'))
    return 'blocked';
  if (awaiting.length || tasks.some((t) => t.status === 'awaiting-approval'))
    return 'awaiting-approval';
  if (active.some((b) => b.status === 'working')) return 'working';
  if (bots.length && !active.length) return 'stood-down';
  return 'idle';
}

function attentionFor(
  unitId: string,
  bots: BotView[],
  tasks: TaskView[],
  backbriefs: BackbriefView[],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const bb of backbriefs) {
    items.push({
      kind: 'awaiting-approval',
      label: `Backbrief awaiting approval: ${bb.mission.goal}`,
      link: `/approvals#backbrief-${bb.id}`,
      entityId: bb.id,
    });
  }
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
  for (const t of tasks.filter((t) => t.status === 'awaiting-approval')) {
    const deploy = t.kind === 'deploy';
    items.push({
      kind: 'awaiting-approval',
      label: deploy
        ? `Production deploy awaiting approval: #${t.number} ${t.title}`
        : `Task #${t.number} awaiting approval`,
      link: taskLink(unitId, t.botId, t.id),
      entityId: t.id,
      ...(deploy ? { action: 'approve-deploy' as const } : {}),
    });
  }
  return items;
}
