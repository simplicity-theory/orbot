import { z } from 'zod';
import { Id } from '../domain/entities.js';
import { TaskStatus } from '../status/status.js';

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
  artifact: z.object({ kind: z.enum(['commit', 'file']), ref: z.string(), summary: z.string() }),
  cost: z.object({ units: z.number().nonnegative(), total: z.number().nonnegative() }),
  'credential.used': z.object({ secretName: z.string(), purpose: z.string() }),
  'policy.check': z.object({
    action: z.string(),
    allowed: z.boolean(),
    reason: z.string(),
  }),
  'redaction.applied': z.object({
    detectors: z.array(z.string()),
    where: z.string(),
    count: z.number().int(),
  }),
  'chat.message': z.object({
    /** `hq` or a unit id. */
    channel: z.string(),
    from: z.enum(['commander', 'overseer', 'hq']),
    text: z.string(),
  }),
  'secret.stored': z.object({ secretName: z.string() }),
  'secret.revoked': z.object({ secretName: z.string() }),
  'run.started': z.object({ runId: z.string(), runtime: z.string() }),
  'run.finished': z.object({ runId: z.string(), outcome: z.enum(['done', 'failed', 'blocked', 'stopped']) }),
} as const;

export type RecordEventKind = keyof typeof RecordEventBodies;
export const RECORD_EVENT_KINDS = Object.keys(RecordEventBodies) as RecordEventKind[];
export const RecordEventKindSchema = z.enum(RECORD_EVENT_KINDS as [RecordEventKind, ...RecordEventKind[]]);

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
