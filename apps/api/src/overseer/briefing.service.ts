import { Injectable } from '@nestjs/common';
import type {
  BriefDiaryEntry,
  BriefFieldManualEntry,
  BriefHandover,
  RecordEvent,
  RecordSearchResult,
  RecordVersion,
  TaskBody,
  TaskBrief,
  UnitBody,
  Workspace,
} from '@orbot/shared';
import { FieldManualService } from '../documents/field-manual.service.js';
import { UnitDocsService } from '../documents/unit-docs.service.js';
import { HoldPolicyService } from '../policy/hold-policy.service.js';
import { RecordService } from '../record/record.service.js';
import { words } from '../common/similarity.js';

/** All entries go in the brief up to this many; beyond it, only the most relevant. */
const FULL_MANUAL_LIMIT = 12;
const RELEVANT_LIMIT = 8;
const DIARY_LIMIT = 10;

export interface UnitKnowledge {
  lastHandover: BriefHandover | null;
  fieldManual: BriefFieldManualEntry[];
  recentDiary: BriefDiaryEntry[];
}

/**
 * Every bot is a replacement arriving on day one. Before each task it is briefed
 * from the unit's documents only: the last handover for this work, the relevant
 * Field Manual entries, and recent War Diary entries. Anything else it can search for.
 */
@Injectable()
export class BriefingService {
  constructor(
    private readonly record: RecordService,
    private readonly fieldManual: FieldManualService,
    private readonly docs: UnitDocsService,
    private readonly holds: HoldPolicyService,
  ) {}

  async build(
    runId: string,
    task: RecordVersion<TaskBody>,
    bot: { id: string; callsign: string; role: string },
    unit: RecordVersion<UnitBody>,
    workspace: Workspace,
    actor: string,
  ): Promise<TaskBrief> {
    // Pick up any edits humans made to the unit's Markdown files first.
    await this.docs.sync(unit.entityId);
    const k = await this.knowledge(unit.entityId, task);
    const recon = await this.reconReports(unit.entityId, task);
    await this.record.event(
      'task.briefed',
      {
        runId,
        handoverId: k.lastHandover?.documentId ?? null,
        handoverVersion: k.lastHandover?.version ?? null,
        fieldManualEntryIds: k.fieldManual.map((e) => e.entryId),
        diaryEventIds: k.recentDiary.map((d) => d.eventId),
        reconDocumentIds: recon.map((r) => r.documentId),
      },
      {
        unitId: unit.entityId,
        botId: bot.id,
        taskId: task.entityId,
        missionId: task.body.missionId,
      },
      actor,
    );
    return {
      runId,
      taskId: task.entityId,
      task: { ...task.body, workspace, status: 'working' },
      bot,
      unit: {
        id: unit.entityId,
        name: unit.body.name,
        standingOrders: unit.body.standingOrders.map((s) => s.text),
        rulesOfEngagement: unit.body.rulesOfEngagement,
        holdPolicy: await this.holds.effectiveFor(task, unit),
      },
      autonomous: await this.autonomous(task),
      preparing: await this.preparing(task),
      workspace,
      repository: await this.repository(task),
      permissions: await this.permissions(task.entityId),
      ...k,
      rulings: await this.rulings(task.entityId),
      recon,
    };
  }

  /** The repository the task works in, with the shape of the product when ORBOT templated it. */
  private async repository(task: RecordVersion<TaskBody>): Promise<TaskBrief['repository']> {
    const s = task.body.repoSupplyId
      ? await this.record.getActive('supply', task.body.repoSupplyId)
      : null;
    if (!s || s.body.spec.kind !== 'repository') return null;
    return { name: s.body.name, project: s.body.spec.project };
  }

  /** The unit's recon reports that share the most words with this work (at most two). */
  private async reconReports(
    unitId: string,
    task: RecordVersion<TaskBody>,
  ): Promise<TaskBrief['recon']> {
    const docs = (
      await this.record.listActive('document', { unitId, bodyContains: { kind: 'recon' } })
    ).filter((d) => d.body.taskId !== task.entityId);
    const topic = words(`${task.body.title} ${task.body.description}`);
    return docs
      .map((d) => {
        let score = 0;
        for (const w of words(`${d.body.title} ${d.body.markdown}`)) if (topic.has(w)) score++;
        return { d, score };
      })
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score || b.d.createdAt.localeCompare(a.d.createdAt))
      .slice(0, 2)
      .map(({ d }) => ({ documentId: d.entityId, title: d.body.title, markdown: d.body.markdown }));
  }

  /** Rulings on disputes this task raised; the Commander's (final) ruling wins over HQ's. */
  /** A check task whose mission still waits for the handoff prepares first (D129). */
  private async preparing(task: RecordVersion<TaskBody>): Promise<boolean> {
    if (task.body.kind !== 'check' || !task.body.missionId) return false;
    const mission = await this.record.getActive('mission', task.body.missionId);
    return mission?.body.status === 'waiting';
  }

  private async rulings(taskId: string): Promise<TaskBrief['rulings']> {
    const disputes = await this.record.listActive('dispute', { bodyContains: { taskId } });
    const out: TaskBrief['rulings'] = [];
    for (const d of disputes) {
      const r = d.body.commanderRuling ?? d.body.hqRuling;
      if (!r) continue;
      const winner = await this.record.getActive(
        'unit',
        r.prevails === 'raiser' ? d.body.unitId : d.body.againstUnitId,
      );
      const who = d.body.commanderRuling ? 'The Commander (final)' : 'HQ';
      out.push({
        disputeId: d.entityId,
        text: `${who} ruled: ${winner?.body.name ?? 'the other unit'} prevails. ${r.reasoning}`,
      });
    }
    return out;
  }

  /** Whether the task's operation runs in a fully automatic theatre. */
  private async autonomous(task: RecordVersion<TaskBody>): Promise<boolean> {
    const mission = task.body.missionId
      ? await this.record.getActive('mission', task.body.missionId)
      : null;
    const op = mission?.body.operationId
      ? await this.record.getActive('operation', mission.body.operationId)
      : null;
    return !!op?.body.autonomous;
  }

  /** Decisions on what this task asked permission for, oldest first. */
  private async permissions(taskId: string): Promise<TaskBrief['permissions']> {
    const decided = (await this.record.listEvents({
      taskId,
      kinds: ['permission.decided'],
      limit: 100,
    })) as RecordEvent<'permission.decided'>[];
    return decided.map((e) => ({
      action: e.body.action,
      approved: e.body.approve,
      note: e.body.note,
    }));
  }

  /** What the unit's documents say about this work. Used for briefs and cold-start checks. */
  async knowledge(unitId: string, task: RecordVersion<TaskBody> | null): Promise<UnitKnowledge> {
    const [lastHandover, fieldManual, recentDiary] = await Promise.all([
      task ? this.lastHandover(unitId, task) : null,
      this.relevantEntries(unitId, task ? `${task.body.title} ${task.body.description}` : ''),
      this.recentDiary(unitId, task?.body.missionId ?? null),
    ]);
    return { lastHandover, fieldManual, recentDiary };
  }

  async lastHandover(unitId: string, task: RecordVersion<TaskBody>): Promise<BriefHandover | null> {
    for (const taskId of [task.entityId, task.body.continuesTaskId].filter(
      (x): x is string => !!x,
    )) {
      const [doc] = await this.record.listActive('document', {
        unitId,
        bodyContains: { kind: 'handover', taskId },
      });
      if (doc)
        return {
          documentId: doc.entityId,
          version: doc.version,
          title: doc.body.title,
          markdown: doc.body.markdown,
        };
    }
    return null;
  }

  /** Pinned entries plus those sharing the most words with the work; everything if the manual is short. */
  async relevantEntries(unitId: string, about: string): Promise<BriefFieldManualEntry[]> {
    const entries = await this.fieldManual.entries(unitId);
    const toBrief = (e: (typeof entries)[number]) => ({
      entryId: e.entityId,
      version: e.version,
      title: e.body.title,
      body: e.body.body,
    });
    if (entries.length <= FULL_MANUAL_LIMIT) return entries.map(toBrief);
    const topic = words(about);
    const scored = entries.map((e) => {
      let score = e.body.pinned ? 1000 : 0;
      for (const w of words(`${e.body.title} ${e.body.body}`)) if (topic.has(w)) score++;
      return { e, score };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, RELEVANT_LIMIT)
      .map(({ e }) => toBrief(e));
  }

  async recentDiary(unitId: string, missionId: string | null): Promise<BriefDiaryEntry[]> {
    const fromMission = missionId
      ? await this.record.listEvents(
          { unitId, kinds: ['diary.entry'], limit: DIARY_LIMIT },
          { latest: true, missionId },
        )
      : [];
    const events = fromMission.length
      ? fromMission
      : await this.record.listEvents(
          { unitId, kinds: ['diary.entry'], limit: DIARY_LIMIT },
          { latest: true },
        );
    return (events as RecordEvent<'diary.entry'>[]).map((e) => ({
      eventId: e.id,
      category: e.body.category,
      text: e.body.text,
      at: e.createdAt,
    }));
  }

  /** On-demand search for a bot: the unit's current documents first, the archive as fallback. */
  async search(unitId: string, query: string): Promise<RecordSearchResult[]> {
    const q = [...words(query)].join(' or ');
    if (!q) return [];
    const active = await this.record.search({ q, scope: 'active', unitId, limit: 10 });
    const hits = active.length
      ? active
      : await this.record.search({ q, scope: 'archive', unitId, limit: 10 });
    return hits.map((h) => ({ title: h.title, snippet: h.snippet, archived: h.archived }));
  }
}
