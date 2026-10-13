import { z } from 'zod';
import { Id } from '../domain/entities.js';
import { TaskStatus } from '../status/status.js';
import { ChatAction, MessageKind } from '../chat/chat.js';

const Link = z.object({ label: z.string(), link: z.string() });

/**
 * Immutable, never-versioned record events: the War Diary, sitreps, each bot's
 * working record, credential use (by name), policy checks and audit entries.
 */
export const DiaryCategory = z.enum(['decision', 'surprise', 'note']);
export type DiaryCategory = z.infer<typeof DiaryCategory>;

export const SitrepLevel = z.enum(['bot', 'unit', 'hq']);
export type SitrepLevel = z.infer<typeof SitrepLevel>;

export const RecordEventBodies = {
  'task.assigned': z.object({ taskNumber: z.number().int(), title: z.string() }),
  'task.status': z.object({ from: TaskStatus, to: TaskStatus, reason: z.string().nullable() }),
  'workspace.prepared': z.object({ path: z.string(), branch: z.string(), baseCommit: z.string() }),
  'bot.step': z.object({ action: z.string(), detail: z.string(), outcome: z.string().nullable() }),
  'diary.entry': z.object({ category: DiaryCategory, text: z.string() }),
  sitrep: z.object({ level: SitrepLevel, text: z.string(), status: TaskStatus.nullable() }),
  artifact: z.object({
    kind: z.enum(['commit', 'file', 'deployment']),
    ref: z.string(),
    summary: z.string(),
  }),
  'operation.phase': z.object({ from: z.string(), to: z.string(), reason: z.string() }),
  /** Work passed from one unit to the next in an operation. */
  handoff: z.object({
    fromUnitId: z.string(),
    toUnitId: z.string(),
    fromMissionId: z.string(),
    toMissionId: z.string(),
    ref: z.string(),
    commit: z.string(),
  }),
  /** A failed check sent work back to the previous unit. */
  sendback: z.object({
    fromUnitId: z.string(),
    toUnitId: z.string(),
    reason: z.string(),
    fixTaskId: z.string(),
  }),
  integration: z.object({ branch: z.string(), commit: z.string(), from: z.string() }),
  deployment: z.object({ environment: z.string(), ref: z.string(), commit: z.string() }),
  'deploy.approval': z.object({
    status: z.enum(['approved', 'rejected']),
    note: z.string().nullable(),
  }),
  'after-action': z.object({
    documentId: z.string(),
    lessons: z.array(z.object({ unitId: z.string().nullable(), text: z.string() })),
  }),
  /**
   * Stuck work going up the chain. One chain (same `chainId`) has a step per level:
   * what that level saw and what it did. The Commander level stays open until resolved.
   */
  escalation: z.object({
    chainId: z.string(),
    cause: z.enum(['stall', 'timeout', 'repeated-failure', 'failing-bot']),
    level: z.enum(['overseer', 'hq', 'commander']),
    text: z.string(),
    action: z.string(),
    runId: z.string().nullable(),
  }),
  /** A bot raised a dispute with another unit about its task (the task waits for a ruling). */
  'dispute.raised': z.object({ against: z.string(), claim: z.string() }),
  /** HQ found two active tasks changing the same files in one repository. */
  deconfliction: z.object({
    repoSupplyId: z.string(),
    paths: z.array(z.string()),
    /** The two tasks, earliest first. */
    taskIds: z.array(z.string()),
    unitIds: z.array(z.string()),
  }),
  'escalation.resolved': z.object({ chainId: z.string(), note: z.string() }),
  /** Spending crossed the warning share of a compute budget (unit, operation or task). */
  'budget.warning': z.object({
    scope: z.enum(['unit', 'operation', 'task']),
    targetId: z.string(),
    label: z.string(),
    spent: z.number(),
    cap: z.number(),
  }),
  /** A compute budget cap changed; work held at the old cap is released. */
  'budget.set': z.object({
    scope: z.enum(['unit', 'operation']),
    targetId: z.string(),
    from: z.number().nullable(),
    to: z.number().nullable(),
    releasedTaskIds: z.array(z.string()),
  }),
  /** A stand-down order given (or lifted) for one bot, one unit or everything. */
  'stand-down': z.object({
    scope: z.enum(['all', 'unit', 'bot']),
    targetId: z.string().nullable(),
    reason: z.string(),
    /** Tasks that were running and paused with a handover. */
    pausedTaskIds: z.array(z.string()),
  }),
  'stand-down.lifted': z.object({
    scope: z.enum(['all', 'unit', 'bot']),
    targetId: z.string().nullable(),
    reason: z.string(),
    /** Tasks put back in the queue. */
    resumedTaskIds: z.array(z.string()),
  }),
  /** The main effort changed (operationId null: no main effort). */
  'main-effort': z.object({
    operationId: z.string().nullable(),
    previousOperationId: z.string().nullable(),
    reason: z.string(),
  }),
  /** Supporting work made way for the main effort: moved to a free bot, or paused with a handover. */
  'main-effort.yield': z.object({
    mainEffortTaskId: z.string(),
    how: z.enum(['moved', 'paused']),
    /** The paused supporting task (how: paused), or the bot the task moved to (how: moved). */
    yieldedTaskId: z.string().nullable(),
    toBotId: z.string().nullable(),
  }),
  cost: z.object({ units: z.number().nonnegative(), total: z.number().nonnegative() }),
  'credential.used': z.object({ secretName: z.string(), purpose: z.string() }),
  'policy.check': z.object({
    action: z.string(),
    allowed: z.boolean(),
    reason: z.string(),
  }),
  /**
   * HQ rehearsed an operation's plan on the sand table: walked each mission against the
   * units' orders, bots, supply and budgets, before the work is done for real.
   */
  'sand-table': z.object({
    verdict: z.enum(['go', 'no-go']),
    findings: z.array(
      z.object({
        severity: z.enum(['blocker', 'risk', 'note']),
        unitId: z.string().nullable(),
        missionId: z.string().nullable(),
        text: z.string(),
        /** What to do about it, and where. */
        fix: z.string().nullable(),
        link: z.string().nullable(),
      }),
    ),
    /** HQ's estimate: tasks and compute units per mission, and in total. */
    missions: z.array(
      z.object({ missionId: z.string(), unitId: z.string(), tasks: z.number(), units: z.number() }),
    ),
    estimate: z.object({ tasks: z.number(), units: z.number() }),
  }),
  /**
   * An alert to the Commander's phone. The push URL is never recorded: only the name of
   * the credential that holds it, and whether delivery worked.
   */
  'alert.sent': z.object({
    kind: z.string(),
    title: z.string(),
    text: z.string(),
    link: z.string(),
    credentialName: z.string(),
    delivered: z.boolean(),
    error: z.string().nullable(),
  }),
  /** A bot filed a report (recon findings) as a unit document. */
  'report.filed': z.object({ documentId: z.string(), title: z.string() }),
  'redaction.applied': z.object({
    detectors: z.array(z.string()),
    where: z.string(),
    count: z.number().int(),
  }),
  'task.briefed': z.object({
    runId: z.string(),
    handoverId: z.string().nullable(),
    handoverVersion: z.number().int().nullable(),
    fieldManualEntryIds: z.array(z.string()),
    diaryEventIds: z.array(z.string()),
    reconDocumentIds: z.array(z.string()).default([]),
  }),
  'task.reassigned': z.object({
    fromBotId: z.string().nullable(),
    toBotId: z.string(),
    reason: z.string(),
  }),
  curation: z.object({
    action: z.enum(['promote', 'merge', 'retire', 'edit']),
    entryId: z.string(),
    title: z.string(),
    sources: z.array(z.string()),
    reason: z.string(),
  }),
  'coldstart.check': z.object({
    taskId: z.string().nullable(),
    taskNumber: z.number().int().nullable(),
    score: z.number().min(0).max(100),
    gaps: z.array(z.string()),
    fixes: z.array(z.string()),
  }),
  'docs.synced': z.object({
    commit: z.string().nullable(),
    files: z.array(z.string()),
    imported: z.array(z.string()),
  }),
  'chat.message': z.object({
    /** `hq` or a unit id. */
    channel: z.string(),
    from: z.enum(['commander', 'overseer', 'hq']),
    text: z.string(),
    /** For orders relayed by HQ: the channel they came from. */
    relayedFrom: z.string().nullable().default(null),
  }),
  /** The Overseer's structured reply to a Commander message. */
  'chat.readback': z.object({
    channel: z.string(),
    replyTo: z.string(),
    kinds: z.array(MessageKind),
    /** "Wilco." when something changed; otherwise the answer or a question back. */
    text: z.string(),
    answer: z.string().nullable(),
    items: z.array(
      z.object({
        ordersLogId: z.string(),
        summary: z.string(),
        links: z.array(Link),
        reversible: z.boolean(),
        routedVia: z.string().nullable(),
      }),
    ),
    pending: z.array(
      z.object({
        pendingId: z.string(),
        summary: z.string(),
        reason: z.enum(['musing', 'irreversible']),
        phrase: z.string().nullable(),
      }),
    ),
    missing: z.array(z.string()),
    unclear: z.array(z.string()),
  }),
  /** One chat-caused change. Undo appends another entry that `reverses` it. */
  'orders.log': z.object({
    messageId: z.string().nullable(),
    channel: z.string(),
    action: ChatAction,
    summary: z.string(),
    links: z.array(Link),
    /** How to reverse it; null if it cannot be undone. */
    inverse: ChatAction.nullable(),
    reverses: z.string().nullable(),
    routedVia: z.string().nullable(),
  }),
  'pending.action': z.object({
    messageId: z.string(),
    channel: z.string(),
    action: ChatAction,
    summary: z.string(),
    reason: z.enum(['musing', 'irreversible']),
    phrase: z.string().nullable(),
  }),
  'pending.resolved': z.object({
    pendingId: z.string(),
    outcome: z.enum(['confirmed', 'declined']),
    ordersLogId: z.string().nullable(),
  }),
  /** A change to orders delivered to a bot mid-task. */
  frago: z.object({ text: z.string(), source: z.string().nullable() }),
  'secret.stored': z.object({ secretName: z.string() }),
  'secret.revoked': z.object({ secretName: z.string() }),
  'run.started': z.object({ runId: z.string(), runtime: z.string() }),
  'run.finished': z.object({
    runId: z.string(),
    outcome: z.enum(['done', 'failed', 'blocked', 'stopped']),
  }),
} as const;

export type RecordEventKind = keyof typeof RecordEventBodies;
export const RECORD_EVENT_KINDS = Object.keys(RecordEventBodies) as RecordEventKind[];
export const RecordEventKindSchema = z.enum(
  RECORD_EVENT_KINDS as [RecordEventKind, ...RecordEventKind[]],
);

export type RecordEventBody<K extends RecordEventKind> = z.infer<(typeof RecordEventBodies)[K]>;

export interface RecordEventRefs {
  unitId?: string | null;
  botId?: string | null;
  taskId?: string | null;
  operationId?: string | null;
  missionId?: string | null;
}

export interface RecordEvent<K extends RecordEventKind = RecordEventKind> {
  id: string;
  seq: number;
  kind: K;
  unitId: string | null;
  botId: string | null;
  taskId: string | null;
  operationId: string | null;
  missionId: string | null;
  actor: string;
  body: RecordEventBody<K>;
  createdAt: string;
}

export const EventQuery = z.object({
  unitId: Id.optional(),
  botId: Id.optional(),
  taskId: Id.optional(),
  operationId: Id.optional(),
  kinds: z.array(RecordEventKindSchema).optional(),
  afterSeq: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type EventQuery = z.infer<typeof EventQuery>;
