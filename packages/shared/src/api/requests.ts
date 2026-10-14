import { z } from 'zod';
import { Rank } from '../domain/principal.js';
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

/** Connect a server bots log in to over SSH, as an environment. */
export const ConnectServerRequest = z.object({
  name: z.string().trim().min(1).max(100),
  tier: z.enum(['staging', 'production']),
  host: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.:_-]+$/, { message: 'A host name or IP address, without user or port.' }),
  port: z.number().int().min(1).max(65535).default(22),
  user: z
    .string()
    .trim()
    .regex(/^[a-z_][a-z0-9_.-]{0,31}$/i, { message: 'A Linux user name.' }),
  credentialName: z.string().trim().min(1),
  url: z.string().trim().max(500).nullable().default(null),
});
export type ConnectServerRequest = z.input<typeof ConnectServerRequest>;

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
  /** Send the building unit to recon first; HQ plans once the report is in. */
  reconFirst: z.boolean().optional(),
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

export const ResolveEscalationRequest = z.object({
  note: z.string().trim().min(1).max(500),
});
export type ResolveEscalationRequest = z.input<typeof ResolveEscalationRequest>;

/** The Commander's ruling on a dispute: final. */
export const RuleDisputeRequest = z.object({
  prevails: z.enum(['raiser', 'other']),
  reasoning: z.string().trim().min(1).max(1000),
});
export type RuleDisputeRequest = z.input<typeof RuleDisputeRequest>;

/** Name the main effort (an operation), or clear it with null. */
export const SetMainEffortRequest = z.object({
  operationId: Id.nullable(),
  reason: z.string().trim().min(1).max(500),
});
export type SetMainEffortRequest = z.input<typeof SetMainEffortRequest>;

/** Send a unit on recon: a read-only survey of the code that answers a question. */
export const ReconRequest = z.object({
  unitId: Id,
  question: z.string().trim().min(1).max(1000),
  /** The repository to survey; omit for the unit's first. */
  repoSupplyId: Id.nullable().default(null),
});
export type ReconRequest = z.input<typeof ReconRequest>;

/** Appoint an officer. The password is write-only: it goes to the secrets store, hashed. */
export const AppointOfficerRequest = z.object({
  name: z.string().trim().min(1).max(100),
  login: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9._-]{1,39}$/, {
      message:
        'Use 2-40 lowercase letters, digits, dots, dashes or underscores, starting with a letter.',
    }),
  rank: Rank,
  unitIds: z.array(Id).default([]),
  password: z.string().min(12, { message: 'Use at least 12 characters.' }).max(200),
});
export type AppointOfficerRequest = z.input<typeof AppointOfficerRequest>;

/** Change an officer's rank or units, or retire them. */
export const UpdateOfficerRequest = z.object({
  rank: Rank.optional(),
  unitIds: z.array(Id).optional(),
  retired: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
});
export type UpdateOfficerRequest = z.input<typeof UpdateOfficerRequest>;

export const ResetPasswordRequest = z.object({
  password: z.string().min(12, { message: 'Use at least 12 characters.' }).max(200),
});
export type ResetPasswordRequest = z.input<typeof ResetPasswordRequest>;

/** Connect an outside service (GitHub) for one of the depot's repositories. */
export const ConnectServiceRequest = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.enum(['github']).default('github'),
  apiUrl: z.string().trim().url().default('https://api.github.com'),
  owner: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(1).max(100),
  pushUrl: z.string().trim().min(1).max(1000),
  repoSupplyId: Id,
  credentialName: z.string().trim().min(1).nullable().default(null),
  services: z.object({ codeHost: z.boolean(), issues: z.boolean(), pipeline: z.boolean() }),
  closeIssues: z.boolean().default(true),
});
export type ConnectServiceRequest = z.input<typeof ConnectServiceRequest>;

/** Take a tracker issue on as a mission for a unit. */
export const TakeIssueRequest = z.object({ unitId: Id, number: z.number().int().positive() });
export type TakeIssueRequest = z.input<typeof TakeIssueRequest>;
