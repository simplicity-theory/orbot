import { z } from 'zod';
import { BotStatus, TaskStatus } from '../status/status.js';

/**
 * Every domain object is a versioned entity in the permanent record.
 * These schemas describe the `body` of a version; identity, version number,
 * author and timestamps live on the record row itself.
 */
export const ENTITY_TYPES = [
  'unit',
  'bot',
  'operation',
  'mission',
  'task',
  'supply',
  'document',
  'backbrief',
  'fm-entry',
  'settings',
] as const;
export const EntityType = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityType>;

export const Id = z.uuid();

// ---------- Unit ----------

export const ApprovalGate = z.enum([
  'approve-everything',
  'backbriefs-and-deploys',
  'escalations-only',
]);
export type ApprovalGate = z.infer<typeof ApprovalGate>;

export const RulesOfEngagement = z.object({
  /** Things a bot in this unit may do without asking. */
  mayDoAlone: z.array(z.string()),
  /** Things that must be escalated to the Overseer (or further up). */
  mustEscalate: z.array(z.string()),
});
export type RulesOfEngagement = z.infer<typeof RulesOfEngagement>;

export const StandingOrder = z.object({ id: z.string().min(1), text: z.string().min(1) });
export type StandingOrder = z.infer<typeof StandingOrder>;

export const UnitBody = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
  role: z.string().min(1),
  standingMission: z.string().min(1),
  /** Prefix for bot callsigns, e.g. `E` → E-1, E-2. */
  callsignPrefix: z.string().regex(/^[A-Z]{1,3}$/),
  overseerBotId: Id.nullable(),
  approvalGate: ApprovalGate,
  rulesOfEngagement: RulesOfEngagement,
  standingOrders: z.array(StandingOrder),
  /** Supply items allotted to this unit. */
  supplyIds: z.array(Id),
  /** Display order on the ORBAT. */
  order: z.number().int(),
  /** Compute budget granted to the unit, in units (caps are enforced in Phase 5). */
  computeBudget: z.number().nonnegative().default(0),
});
export type UnitBody = z.infer<typeof UnitBody>;

// ---------- Bot ----------

export const BotBody = z.object({
  unitId: Id,
  callsign: z.string().min(1),
  role: z.string().min(1),
  isOverseer: z.boolean(),
  status: BotStatus,
  currentTaskId: Id.nullable(),
  /** Task ids waiting for this bot, in order. */
  queue: z.array(Id),
  /** Which BotRuntime adapter drives this bot. */
  runtime: z.string().min(1),
});
export type BotBody = z.infer<typeof BotBody>;

// ---------- Operation / Mission / Task ----------

export const OperationPhase = z.enum([
  'intent',
  'o-group',
  'backbrief',
  'execution',
  'handoffs',
  'sitreps',
  'after-action',
  'closed',
]);
export type OperationPhase = z.infer<typeof OperationPhase>;

export const OperationBody = z.object({
  name: z.string().min(1),
  intent: z.string().min(1),
  phase: OperationPhase,
  supplyIds: z.array(Id),
});
export type OperationBody = z.infer<typeof OperationBody>;

export const MissionStatus = z.enum([
  'withdrawn',
  'planning',
  'awaiting-approval',
  'working',
  'blocked',
  'done',
  'failed',
]);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const MissionBody = z.object({
  /** Null for missions given straight to a unit (before HQ routes them, Phase 4). */
  operationId: Id.nullable(),
  unitId: Id,
  goal: z.string().min(1),
  definitionOfDone: z.array(z.string().min(1)),
  status: MissionStatus,
});
export type MissionBody = z.infer<typeof MissionBody>;

export const Budget = z.object({
  /** Hard cap in compute units; null = uncapped (Phase 5 enforces caps). */
  limitUnits: z.number().nonnegative().nullable(),
  spentUnits: z.number().nonnegative(),
});
export type Budget = z.infer<typeof Budget>;

export const Workspace = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  repoSupplyId: Id,
  baseCommit: z.string().min(1),
});
export type Workspace = z.infer<typeof Workspace>;

export const TaskBody = z.object({
  /** Human-facing number, e.g. Task #142. */
  number: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string(),
  unitId: Id,
  missionId: Id.nullable(),
  botId: Id.nullable(),
  status: TaskStatus,
  budget: Budget,
  repoSupplyId: Id.nullable(),
  workspace: Workspace.nullable(),
  /** Credential references (secret names) this task may use. Never values. */
  credentialNames: z.array(z.string()),
  /** SimulatedRuntime scenario id; ignored by other runtimes. */
  scenario: z.string().nullable(),
  statusReason: z.string().nullable(),
  /** The task this one picks up from (its handover is part of the brief). */
  continuesTaskId: Id.nullable().default(null),
  /** Started by the Overseer's dispatcher when its bot is free (tasks from approved backbriefs). */
  autoStart: z.boolean().default(false),
});
export type TaskBody = z.infer<typeof TaskBody>;

// ---------- Supply ----------

export const SupplyKind = z.enum(['repository', 'environment', 'tool', 'credential', 'compute']);
export type SupplyKind = z.infer<typeof SupplyKind>;

export const RepositorySupply = z.object({
  kind: z.literal('repository'),
  /** Local path or clone URL as given by the Commander. Credentials are never embedded. */
  location: z.string().min(1),
  /** Local clone the WorkspaceManager creates worktrees from. */
  localPath: z.string().min(1),
  defaultBranch: z.string().min(1),
});

export const CredentialSupply = z.object({
  kind: z.literal('credential'),
  /** Name of the secret in the secrets store. The value is never here. */
  secretName: z.string().min(1),
});

export const GenericSupply = z.object({
  kind: z.enum(['environment', 'tool', 'compute']),
  /** For environments: `tier` is `staging` or `production` (production deploy rights are irreversible). */
  details: z.record(z.string(), z.string()),
});

export const SupplyBody = z.object({
  name: z.string().min(1),
  connected: z.boolean(),
  spec: z.discriminatedUnion('kind', [RepositorySupply, CredentialSupply, GenericSupply]),
});
export type SupplyBody = z.infer<typeof SupplyBody>;

// ---------- Documents ----------

export const DocumentKind = z.enum([
  'field-manual',
  'standing-orders',
  'handover',
  'after-action',
  'note',
]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const DocumentBody = z.object({
  kind: DocumentKind,
  unitId: Id.nullable(),
  title: z.string().min(1),
  markdown: z.string(),
  /** For handovers: the task the handover closes. */
  taskId: Id.nullable(),
  botId: Id.nullable(),
});
export type DocumentBody = z.infer<typeof DocumentBody>;

// ---------- Backbrief ----------

export const ProposedTask = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  botId: Id.nullable(),
  /** SimulatedRuntime scenario; ignored by other runtimes. */
  scenario: z.string().nullable(),
});
export type ProposedTask = z.infer<typeof ProposedTask>;

export const BackbriefStatus = z.enum(['awaiting-approval', 'approved', 'rejected']);
export type BackbriefStatus = z.infer<typeof BackbriefStatus>;

export const BackbriefDecision = z.object({
  outcome: z.enum(['approved', 'amended', 'rejected', 'auto-approved']),
  by: z.string(),
  note: z.string().nullable(),
  at: z.iso.datetime({ offset: true }),
});
export type BackbriefDecision = z.infer<typeof BackbriefDecision>;

/** A unit's plan for a mission, briefed back to the Commander for approval. */
export const BackbriefBody = z.object({
  missionId: Id,
  unitId: Id,
  overseerBotId: Id,
  summary: z.string().min(1),
  proposedTasks: z.array(ProposedTask).min(1),
  risks: z.array(z.string()),
  status: BackbriefStatus,
  decision: BackbriefDecision.nullable(),
  /** 1 for the first plan; +1 every time the Commander sends it back. */
  round: z.number().int().positive(),
  /** Notes the Commander attached when rejecting earlier rounds. */
  commanderNotes: z.array(z.string()),
  /** Tasks created when it was approved. */
  taskIds: z.array(Id),
});
export type BackbriefBody = z.infer<typeof BackbriefBody>;

// ---------- Field Manual entry ----------

export const SourceRef = z.object({
  kind: z.enum(['handover', 'diary', 'commander', 'coldstart', 'git']),
  /** Document id (handover), event id (diary), or null. */
  id: z.string().nullable(),
  version: z.number().int().nullable(),
  label: z.string(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/**
 * One lasting lesson in a unit's Field Manual. Each entry is versioned on its own,
 * so where it came from (provenance), merges and retirement all have history.
 */
export const FmEntryBody = z.object({
  unitId: Id,
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000),
  tags: z.array(z.string()),
  /** Always included in briefs, whatever the task. */
  pinned: z.boolean(),
  retired: z.boolean(),
  retiredReason: z.string().nullable(),
  sources: z.array(SourceRef),
});
export type FmEntryBody = z.infer<typeof FmEntryBody>;

// ---------- Settings ----------

/** Product settings that change behaviour without code changes. One versioned entity. */
export const SettingsBody = z.object({
  /** Chat action kinds that need a typed one-line confirmation before they run. */
  irreversibleActions: z.array(z.string()),
  /** The phrase the Commander types to confirm an irreversible order. */
  confirmationPhrase: z.string().min(1),
});
export type SettingsBody = z.infer<typeof SettingsBody>;

/** Well-known id of the settings entity. */
export const SETTINGS_ID = '00000000-0000-4000-8000-000000000001';

export const DEFAULT_SETTINGS: SettingsBody = {
  irreversibleActions: ['grant-deploy-rights'],
  confirmationPhrase: 'confirm',
};

// ---------- Registry ----------

export const ENTITY_BODY_SCHEMAS = {
  unit: UnitBody,
  bot: BotBody,
  operation: OperationBody,
  mission: MissionBody,
  task: TaskBody,
  supply: SupplyBody,
  document: DocumentBody,
  backbrief: BackbriefBody,
  'fm-entry': FmEntryBody,
  settings: SettingsBody,
} as const satisfies Record<EntityType, z.ZodType>;

export interface EntityBodyMap {
  unit: UnitBody;
  bot: BotBody;
  operation: OperationBody;
  mission: MissionBody;
  task: TaskBody;
  supply: SupplyBody;
  document: DocumentBody;
  backbrief: BackbriefBody;
  'fm-entry': FmEntryBody;
  settings: SettingsBody;
}
