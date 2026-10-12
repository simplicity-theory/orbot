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
  'planning',
  'awaiting-approval',
  'working',
  'blocked',
  'done',
  'failed',
]);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const MissionBody = z.object({
  operationId: Id,
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

// ---------- Registry ----------

export const ENTITY_BODY_SCHEMAS = {
  unit: UnitBody,
  bot: BotBody,
  operation: OperationBody,
  mission: MissionBody,
  task: TaskBody,
  supply: SupplyBody,
  document: DocumentBody,
} as const satisfies Record<EntityType, z.ZodType>;

export interface EntityBodyMap {
  unit: UnitBody;
  bot: BotBody;
  operation: OperationBody;
  mission: MissionBody;
  task: TaskBody;
  supply: SupplyBody;
  document: DocumentBody;
}
