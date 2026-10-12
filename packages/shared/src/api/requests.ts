import { z } from 'zod';
import { DocumentKind, Id, ProposedTask } from '../domain/entities.js';

/** Request bodies shared by the API (validation) and the web app (typing). */

export const CreateTaskRequest = z.object({
  unitId: Id,
  botId: Id.nullable().default(null),
  missionId: Id.nullable().default(null),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
  repoSupplyId: Id.nullable().default(null),
  credentialNames: z.array(z.string()).default([]),
  scenario: z.string().nullable().default(null),
  budgetLimitUnits: z.number().nonnegative().nullable().default(null),
  /** Pick up from another task: its handover is part of this task's brief. */
  continuesTaskId: Id.nullable().default(null),
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequest>;

export const ConnectRepositoryRequest = z.object({
  name: z.string().trim().min(1).max(100),
  /** Local path to a git repository, or a clone URL (without embedded credentials). */
  location: z.string().trim().min(1).max(1000),
  defaultBranch: z.string().trim().min(1).max(200).optional(),
});
export type ConnectRepositoryRequest = z.input<typeof ConnectRepositoryRequest>;

export const StoreCredentialRequest = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{1,99}$/, {
      message: 'Use lowercase letters, digits, dots, dashes and underscores.',
    }),
  /** Write-only. Never returned by any endpoint. */
  value: z.string().min(4).max(20_000),
});
export type StoreCredentialRequest = z.input<typeof StoreCredentialRequest>;

export const CreateDocumentRequest = z.object({
  kind: DocumentKind,
  unitId: Id.nullable(),
  title: z.string().trim().min(1).max(200),
  markdown: z.string().max(200_000),
});
export type CreateDocumentRequest = z.input<typeof CreateDocumentRequest>;

export const ReviseDocumentRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  markdown: z.string().max(200_000),
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});
export type ReviseDocumentRequest = z.input<typeof ReviseDocumentRequest>;

export const CreateMissionRequest = z.object({
  unitId: Id,
  goal: z.string().trim().min(1).max(500),
  definitionOfDone: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
});
export type CreateMissionRequest = z.input<typeof CreateMissionRequest>;

export const ApproveBackbriefRequest = z.object({
  note: z.string().trim().max(2000).nullable().default(null),
  expectedVersion: z.number().int().positive(),
});
export type ApproveBackbriefRequest = z.input<typeof ApproveBackbriefRequest>;

export const AmendBackbriefRequest = z.object({
  proposedTasks: z.array(ProposedTask).min(1).max(50),
  note: z.string().trim().min(1).max(2000),
  expectedVersion: z.number().int().positive(),
});
export type AmendBackbriefRequest = z.input<typeof AmendBackbriefRequest>;

export const RejectBackbriefRequest = z.object({
  note: z.string().trim().min(1, { message: 'Tell the Overseer what to change.' }).max(2000),
  expectedVersion: z.number().int().positive(),
});
export type RejectBackbriefRequest = z.input<typeof RejectBackbriefRequest>;

export const ReassignTaskRequest = z.object({
  botId: Id,
  reason: z.string().trim().min(1).max(500),
});
export type ReassignTaskRequest = z.input<typeof ReassignTaskRequest>;

export const AddBotRequest = z.object({
  role: z.string().trim().min(1).max(200),
  /** Replace this bot: it is stood down and its work moves to the new bot. */
  replacesBotId: Id.nullable().default(null),
  reason: z.string().trim().min(1).max(500),
});
export type AddBotRequest = z.input<typeof AddBotRequest>;

export const CreateFmEntryRequest = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000),
  tags: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  reason: z.string().trim().min(1).max(500),
});
export type CreateFmEntryRequest = z.input<typeof CreateFmEntryRequest>;

export const ReviseFmEntryRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(20_000).optional(),
  pinned: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});
export type ReviseFmEntryRequest = z.input<typeof ReviseFmEntryRequest>;

export const RetireFmEntryRequest = z.object({
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});
export type RetireFmEntryRequest = z.input<typeof RetireFmEntryRequest>;

export const StandingOrdersRequest = z.object({
  orders: z.array(
    z.object({ id: z.string().optional(), text: z.string().trim().min(1).max(1000) }),
  ),
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});
export type StandingOrdersRequest = z.input<typeof StandingOrdersRequest>;

export const CreateOperationRequest = z.object({
  intent: z.string().trim().min(1).max(1000),
  name: z.string().trim().min(1).max(100).optional(),
  /** Hard cap on the operation's compute spend; omit for none. */
  budgetUnits: z.number().int().positive().max(1_000_000).nullable().optional(),
});
export type CreateOperationRequest = z.input<typeof CreateOperationRequest>;

export const DeployDecisionRequest = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).nullable().default(null),
});
export type DeployDecisionRequest = z.input<typeof DeployDecisionRequest>;

export const StandDownScope = z.enum(['all', 'unit', 'bot']);
export type StandDownScope = z.infer<typeof StandDownScope>;

/** Stand down (or lift the order for) one bot, one unit, or everything. */
export const StandDownRequest = z
  .object({
    scope: StandDownScope,
    /** Unit or bot id; omit for `all`. */
    targetId: Id.nullable().default(null),
    reason: z.string().trim().min(1).max(500),
  })
  .refine((r) => (r.scope === 'all') === (r.targetId === null), {
    message: 'Give a unit or bot id for a unit or bot stand-down, and none for everything.',
    path: ['targetId'],
  });
export type StandDownRequest = z.input<typeof StandDownRequest>;

/** Set a unit's or an operation's compute budget cap (null on an operation = no cap). */
export const SetBudgetRequest = z.object({
  units: z.number().int().nonnegative().max(1_000_000).nullable(),
  reason: z.string().trim().min(1).max(500),
});
export type SetBudgetRequest = z.input<typeof SetBudgetRequest>;
