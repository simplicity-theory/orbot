import { z } from 'zod';
import { Rank } from '../domain/principal.js';
import { DocumentKind, HoldPolicy, Id, ProjectKind, ProposedTask } from '../domain/entities.js';

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
  /** dev: bots build and test there; staging/production: where work is deployed. */
  tier: z.enum(['dev', 'staging', 'production']),
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

/** How bots log in to a server over SSH. */
export const ServerLogin = ConnectServerRequest.omit({ name: true, tier: true });

/**
 * Change an environment: its name, tier and, for a server, its login. A plain environment
 * becomes a server by giving it a login. A new login is tested before anything is saved.
 */
export const UpdateEnvironmentRequest = z.object({
  name: z.string().trim().min(1).max(100),
  tier: z.enum(['dev', 'staging', 'production']),
  server: ServerLogin.nullable().default(null),
  /** The server was reinstalled (new host key): pin the keys it offers now. */
  repinHostKey: z.boolean().default(false),
});
export type UpdateEnvironmentRequest = z.input<typeof UpdateEnvironmentRequest>;

export const ConnectRepositoryRequest = z.object({
  name: z.string().trim().min(1).max(100),
  /** Local path to a git repository, or a clone URL (without embedded credentials). */
  location: z.string().trim().min(1).max(1000),
  defaultBranch: z.string().trim().min(1).max(200).optional(),
});
export type ConnectRepositoryRequest = z.input<typeof ConnectRepositoryRequest>;

/** A project name: becomes the repository's folder name too. */
const ProjectName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, {
    message: 'Use letters, digits, spaces, dots, dashes and underscores.',
  });

/** Create a repository from a template (ORBOT makes the first commit) and connect it. */
export const CreateRepositoryRequest = z.object({
  name: ProjectName,
  /** `single-html`: one self-contained HTML file; `empty`: a README only. */
  template: z.enum(['single-html', 'empty']).default('single-html'),
});
export type CreateRepositoryRequest = z.input<typeof CreateRepositoryRequest>;

/** Connect a plain environment, or a static site ORBOT publishes itself (no server). */
export const ConnectEnvironmentRequest = z.object({
  name: z.string().trim().min(1).max(100),
  tier: z.enum(['staging', 'production']),
  /** A static site: deploying publishes files into a folder ORBOT serves. */
  site: z.boolean().default(false),
});
export type ConnectEnvironmentRequest = z.input<typeof ConnectEnvironmentRequest>;

/**
 * Start a new project in one order: a repository from a template, a static site to deploy it to,
 * and (with an intent) the operation that builds it, with both assigned.
 */
export const NewProjectRequest = z.object({
  name: ProjectName,
  kind: ProjectKind.default('single-html'),
  /** What to build; without it only the repository and site are created. */
  intent: z.string().trim().max(1000).nullable().default(null),
  budgetUnits: z.number().positive().nullable().default(null),
  /** Issue the site to this unit now (deploy rights: irreversible, so the web asks first). */
  deployRightsUnitId: Id.nullable().default(null),
});
export type NewProjectRequest = z.input<typeof NewProjectRequest>;

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

/** Set what holds a unit's work. */
export const HoldPolicyRequest = z.object({
  policy: HoldPolicy,
  reason: z.string().trim().max(500).default(''),
});
export type HoldPolicyRequest = z.input<typeof HoldPolicyRequest>;

/** Override (or clear, with null) the hold policy for one operation's work. */
export const OperationHoldPolicyRequest = z.object({
  policy: HoldPolicy.nullable(),
  reason: z.string().trim().max(500).default(''),
});
export type OperationHoldPolicyRequest = z.input<typeof OperationHoldPolicyRequest>;

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
  /** Launch it in a theatre: it starts with everything the theatre holds. */
  theatreId: Id.nullable().optional(),
  /** Hard cap on the operation's compute spend; omit for none. */
  budgetUnits: z.number().int().positive().max(1_000_000).nullable().optional(),
  /** Send the building unit to recon first; HQ plans once the report is in. */
  reconFirst: z.boolean().optional(),
  /** Depot items to assign from the start; it holds at the O Group until it has what it needs. */
  supplyIds: z.array(Id).max(50).optional(),
});
export type CreateOperationRequest = z.input<typeof CreateOperationRequest>;

/** Assign a depot item to an operation, or take it off. */
export const OperationResourceRequest = z.object({
  supplyId: Id,
  reason: z.string().trim().max(500).optional(),
});
export type OperationResourceRequest = z.input<typeof OperationResourceRequest>;

export const CancelOperationRequest = z.object({
  note: z.string().trim().max(500).default(''),
});
export type CancelOperationRequest = z.input<typeof CancelOperationRequest>;

/** Open a theatre: a project with its repository, its site if wanted, and the first intent. */
export const CreateTheatreRequest = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(''),
  repository: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('template'), template: ProjectKind.default('single-html') }),
      z.object({ kind: z.literal('existing'), supplyId: Id }),
      z.object({
        kind: z.literal('location'),
        location: z.string().trim().min(1).max(1000),
        defaultBranch: z.string().trim().min(1).max(200).nullable().default(null),
      }),
    ])
    .nullable()
    .default(null),
  /** A static site ORBOT publishes itself (production tier). */
  site: z.boolean().default(true),
  /** Other depot items the theatre holds from the start. */
  supplyIds: z.array(Id).max(50).default([]),
  /** With an intent, the first operation is launched in it. */
  intent: z.string().trim().max(1000).nullable().default(null),
  budgetUnits: z.number().positive().nullable().default(null),
  /** full (default): plans approved for you, nothing holds, finished work lands and is published. */
  autonomy: z.enum(['full', 'approve']).default('full'),
});
export type CreateTheatreRequest = z.input<typeof CreateTheatreRequest>;

/** State intent inside a theatre. */
export const TheatreIntentRequest = z.object({
  intent: z.string().trim().min(1).max(1000),
  name: z.string().trim().min(1).max(100).optional(),
  budgetUnits: z.number().int().positive().max(1_000_000).nullable().optional(),
  reconFirst: z.boolean().optional(),
  /** Depot items beyond what the theatre holds. */
  supplyIds: z.array(Id).max(50).optional(),
});
export type TheatreIntentRequest = z.input<typeof TheatreIntentRequest>;

/** Plan a campaign in a theatre: its steps, each an intent HQ launches as an operation in turn. */
export const CreateCampaignRequest = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  steps: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100).nullable().default(null),
        intent: z.string().trim().min(1).max(1000),
      }),
    )
    .min(1)
    .max(30),
});
export type CreateCampaignRequest = z.input<typeof CreateCampaignRequest>;

/** Put a theatre's repository on GitHub: the repository is created there if it does not exist, main is pushed, and every landing follows. */
export const GitHubTheatreRequest = z
  .object({
    apiUrl: z.string().trim().url().default('https://api.github.com'),
    owner: z.string().trim().min(1).max(100),
    /** The repository name on GitHub; null = the theatre's name as a slug. */
    repo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .nullable()
      .default(null),
    /** A stored credential holding the token… */
    credentialName: z.string().trim().min(1).nullable().default(null),
    /** …or the token itself, stored now under `token-github-<owner>` (never recorded). */
    token: z.string().trim().min(1).max(500).nullable().default(null),
    private: z.boolean().default(true),
  })
  .refine((r) => r.credentialName || r.token, {
    message: 'A token is needed: choose a stored credential or paste one.',
  });
export type GitHubTheatreRequest = z.input<typeof GitHubTheatreRequest>;

/** Abort a mission, start a mission over, start an operation over: why (optional). */
export const CourseNoteRequest = CancelOperationRequest;
export type CourseNoteRequest = z.input<typeof CourseNoteRequest>;

export const DeployDecisionRequest = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).nullable().default(null),
});
export type DeployDecisionRequest = z.input<typeof DeployDecisionRequest>;

/** Approve or refuse what a bot asked permission for (a refusal says why). */
export const PermissionDecisionRequest = z
  .object({
    approve: z.boolean(),
    note: z.string().trim().max(1000).nullable().default(null),
  })
  .refine((b) => b.approve || !!b.note, {
    message: 'Say why you refuse, so the bot can find another way.',
    path: ['note'],
  });
export type PermissionDecisionRequest = z.input<typeof PermissionDecisionRequest>;

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

/** Install an app from deploy/apps on a server. */
export const InstallAppRequest = z.object({
  app: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  /** Settings by key; missing ones take the manifest's default. Validated against it. */
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Secrets that are chosen (not generated): the credential to use, or null for none. */
  credentials: z.record(z.string(), z.string().nullable()).default({}),
});
export type InstallAppRequest = z.input<typeof InstallAppRequest>;
