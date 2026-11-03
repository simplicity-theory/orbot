import { z } from 'zod';
import { Rank } from './principal.js';
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
  'dispute',
  'officer',
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

/** How bad a finding is (a check's result, a problem a bot runs into). */
export const Severity = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;
/** How big a fix is: a few lines inside the work under review, changes across it, or a rewrite beyond it. */
export const FixSize = z.enum(['small', 'medium', 'large']);
export type FixSize = z.infer<typeof FixSize>;

/**
 * What holds the work and comes to the Commander, set per unit and overridable per operation.
 * A finding a bot can fix within `fixUpTo` is fixed on the spot; otherwise it is recorded, and
 * holds the work only when its severity is at least `holdFrom`. `never` is the automatic mode:
 * nothing ever holds; everything is fixed or recorded and the work goes on.
 */
export const HoldPolicy = z.object({
  holdFrom: z.enum(['low', 'medium', 'high', 'critical', 'never']).default('high'),
  fixUpTo: z.enum(['none', 'small', 'medium', 'large']).default('small'),
});
export type HoldPolicy = z.infer<typeof HoldPolicy>;
export const DEFAULT_HOLD_POLICY: HoldPolicy = { holdFrom: 'high', fixUpTo: 'small' };

export const RulesOfEngagement = z.object({
  /** Things a bot in this unit may do without asking. */
  mayDoAlone: z.array(z.string()),
  /** Things that must be escalated to the Overseer (or further up). */
  mustEscalate: z.array(z.string()),
});
export type RulesOfEngagement = z.infer<typeof RulesOfEngagement>;

export const StandingOrder = z.object({ id: z.string().min(1), text: z.string().min(1) });
export type StandingOrder = z.infer<typeof StandingOrder>;

/**
 * A stand-down order in force: the bot, unit or (on settings) every unit stops work.
 * Running tasks pause with a handover; nothing starts until the order is lifted.
 */
export const Halt = z.object({
  reason: z.string().min(1),
  /** Actor who gave the order. */
  by: z.string().min(1),
  at: z.iso.datetime({ offset: true }),
});
export type Halt = z.infer<typeof Halt>;

/**
 * The main effort: the one operation the force puts first. Its tasks start before
 * supporting work, and (if the setting allows) supporting work makes way for it.
 */
export const MainEffort = z.object({
  operationId: Id,
  reason: z.string().min(1),
  /** Actor who named it. */
  by: z.string().min(1),
  at: z.iso.datetime({ offset: true }),
});
export type MainEffort = z.infer<typeof MainEffort>;

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
  /** What holds the unit's work for the Commander; an operation may override it. */
  holdPolicy: HoldPolicy.default(DEFAULT_HOLD_POLICY),
  /** Supply items allotted to this unit. */
  supplyIds: z.array(Id),
  /** Display order on the ORBAT. */
  order: z.number().int(),
  /** The unit's compute budget: a hard cap on what its bots may spend, in units. 0 = no cap set. */
  computeBudget: z.number().nonnegative().default(0),
  /** Stand-down order on the whole unit (Phase 5). */
  halt: Halt.nullable().default(null),
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
  /** Stand-down order on this bot (Phase 5). */
  halt: Halt.nullable().default(null),
  /** The bot this one replaced, if any (its service record links to it). */
  replacesBotId: Id.nullable().default(null),
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

export const Deployment = z.object({
  environment: z.string(),
  ref: z.string(),
  commit: z.string(),
  taskId: Id,
  at: z.iso.datetime({ offset: true }),
  /** Where the deployed work can be opened, when ORBOT knows (a static site it published). */
  url: z.string().nullable().default(null),
});
export type Deployment = z.infer<typeof Deployment>;

/** A pull request ORBOT opened on a connected code host. */
export const PullRequestRef = z.object({
  connectionId: Id,
  number: z.number().int(),
  url: z.string(),
  branch: z.string(),
});
export type PullRequestRef = z.infer<typeof PullRequestRef>;

/** An issue on a connected tracker that a mission took on. */
export const IssueRef = z.object({
  connectionId: Id,
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
});
export type IssueRef = z.infer<typeof IssueRef>;

/** What an operation can need from the Supply Depot. A server is an environment bots log in to. */
export const ResourceKind = z.enum(['repository', 'server', 'environment', 'model', 'credential']);
export type ResourceKind = z.infer<typeof ResourceKind>;

/**
 * Something an operation needs before its units can start. A required need that no assigned
 * resource meets blocks the operation at the O Group.
 */
export const OperationNeed = z.object({
  kind: ResourceKind,
  /** What it is for, in words. */
  label: z.string().min(1).max(200),
  /** For servers and environments: the tier it must be. */
  tier: z.enum(['dev', 'staging', 'production']).nullable().default(null),
  /** Nice to have: a gap is said, but does not block. */
  optional: z.boolean().default(false),
});
export type OperationNeed = z.infer<typeof OperationNeed>;

/** A mission in HQ's plan, before it is issued. */
export const PlannedMission = z.object({
  unitId: Id,
  stage: z.enum(['build', 'inspect', 'guard', 'deploy']),
  goal: z.string().min(1),
  definitionOfDone: z.array(z.string()),
});
export type PlannedMission = z.infer<typeof PlannedMission>;

export const OperationBody = z.object({
  name: z.string().min(1),
  intent: z.string().min(1),
  phase: OperationPhase,
  /**
   * Resources assigned to the operation (depot items), in the order they were assigned. The
   * first repository is where the work is handed off and deployed from.
   */
  supplyIds: z.array(Id),
  /** What the operation needs; until every required need is met, it holds at the O Group. */
  needs: z
    .array(OperationNeed)
    .default([
      { kind: 'repository', label: 'A repository to work in', tier: null, optional: false },
    ]),
  /** HQ's plan, kept while the operation waits for resources so it is not planned twice. */
  plan: z.array(PlannedMission).nullable().default(null),
  /** Missions in handoff order (Engineers → Inspection → Guard → Logistics). */
  missionIds: z.array(Id).default([]),
  /** Missions withdrawn when the operation was issued again (a new main repository). */
  withdrawnMissionIds: z.array(Id).default([]),
  /** The Commander called it off: closed without an After Action review. */
  cancelled: z
    .object({ by: z.string(), note: z.string(), at: z.iso.datetime({ offset: true }) })
    .nullable()
    .default(null),
  /** Overrides every unit's hold policy for this operation's work; null = each unit's own. */
  holdPolicy: HoldPolicy.nullable().default(null),
  /** The repository the operation's work lands in. */
  repoSupplyId: Id.nullable().default(null),
  /** Branch every unit's work is integrated on, then deployed from. */
  integrationBranch: z.string().nullable().default(null),
  deployment: Deployment.nullable().default(null),
  /** The shared cross-unit record (a document) and the After Action review. */
  recordDocumentId: Id.nullable().default(null),
  afterActionDocumentId: Id.nullable().default(null),
  /** Hard cap on what the whole operation may spend, in compute units; null = no cap. */
  budgetUnits: z.number().nonnegative().nullable().default(null),
  /** HQ sends a unit to recon before planning; the plan takes the report into account. */
  reconFirst: z.boolean().default(false),
  reconTaskId: Id.nullable().default(null),
  /** The pull request for the integration branch, once the code host has one. */
  pullRequest: PullRequestRef.nullable().default(null),
});
export type OperationBody = z.infer<typeof OperationBody>;

export const MissionStatus = z.enum([
  'withdrawn',
  /** Approved, waiting for the upstream unit to hand off. */
  'waiting',
  'planning',
  'awaiting-approval',
  'working',
  'blocked',
  'done',
  'failed',
]);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const MissionStage = z.enum(['build', 'inspect', 'guard', 'deploy']);
export type MissionStage = z.infer<typeof MissionStage>;

/** Which unit role does which stage, in handoff order. */
export const STAGE_ORDER: readonly MissionStage[] = ['build', 'inspect', 'guard', 'deploy'];

export const MissionBody = z.object({
  /** Null for missions given straight to a unit (before HQ routes them, Phase 4). */
  operationId: Id.nullable(),
  unitId: Id,
  goal: z.string().min(1),
  definitionOfDone: z.array(z.string().min(1)),
  status: MissionStatus,
  /** In an operation: the stage this mission is, and the mission that hands off to it. */
  stage: MissionStage.nullable().default(null),
  dependsOnMissionId: Id.nullable().default(null),
  /** The tracker issue this mission took on, if any. */
  issue: IssueRef.nullable().default(null),
  /**
   * Ordered by a person in chat: the order is the approval, so the Overseer's plan proceeds
   * without waiting at the approval gate (which is for work HQ plans).
   */
  preApproved: z.boolean().default(false),
});
export type MissionBody = z.infer<typeof MissionBody>;

export const Budget = z.object({
  /** Hard cap in compute units for this task; null = uncapped. */
  limitUnits: z.number().nonnegative().nullable(),
  spentUnits: z.number().nonnegative(),
});
export type Budget = z.infer<typeof Budget>;

/**
 * The task's branch was restarted from the integrated work because merging it into the branch's
 * earlier commits conflicted. Those commits are kept on `kept` (nothing is lost).
 */
export const WorkspaceRestart = z.object({
  /** The branch's head before the restart. */
  from: z.string().min(1),
  /** The branch that keeps it. */
  kept: z.string().min(1),
  /** The files that conflicted. */
  conflicts: z.array(z.string()),
});
export type WorkspaceRestart = z.infer<typeof WorkspaceRestart>;

export const Workspace = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  repoSupplyId: Id,
  baseCommit: z.string().min(1),
  restarted: WorkspaceRestart.nullable().default(null),
});
export type Workspace = z.infer<typeof Workspace>;

/** `recon` is read-only: the bot surveys the code and files a report, changing nothing. */
export const TaskKind = z.enum(['work', 'fix', 'check', 'deploy', 'recon']);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskApproval = z.object({
  kind: z.literal('production-deploy'),
  status: z.enum(['pending', 'approved', 'rejected']),
  by: z.string().nullable(),
  at: z.iso.datetime({ offset: true }).nullable(),
  note: z.string().nullable(),
});
export type TaskApproval = z.infer<typeof TaskApproval>;

/**
 * A bot asked permission for something its unit's rules of engagement say it must escalate.
 * The task waits (awaiting approval) until the Commander, or the unit's Captain, decides;
 * then it resumes with the decision in its brief.
 */
export const TaskPermission = z.object({
  /** What the bot wants to do. */
  action: z.string().min(1),
  /** The "must escalate" rule it falls under, as the bot quoted it. */
  rule: z.string(),
  /** Why the bot needs to do it. */
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'refused']),
  requestedAt: z.iso.datetime({ offset: true }),
  by: z.string().nullable(),
  at: z.iso.datetime({ offset: true }).nullable(),
  note: z.string().nullable(),
});
export type TaskPermission = z.infer<typeof TaskPermission>;

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
  /** What the Commander can do about a held or failed task (set with `statusReason`). */
  statusAction: z.string().nullable().default(null),
  /** The task this one picks up from (its handover is part of the brief). */
  continuesTaskId: Id.nullable().default(null),
  /** Started by the Overseer's dispatcher when its bot is free (tasks from approved backbriefs). */
  autoStart: z.boolean().default(false),
  kind: TaskKind.default('work'),
  /** Branch the task's workspace is cut from (an operation's integration branch); null = default branch. */
  baseRef: z.string().nullable().default(null),
  /** Production deploys wait for the Commander's approval (per the unit's approval gate). */
  approval: TaskApproval.nullable().default(null),
  /** The bot's latest request for permission under the rules of engagement, if any. */
  permission: TaskPermission.nullable().default(null),
  /** A pull request opened for this task's branch, if any. */
  pullRequest: PullRequestRef.nullable().default(null),
});
export type TaskBody = z.infer<typeof TaskBody>;

// ---------- Supply ----------

export const SupplyKind = z.enum([
  'repository',
  'environment',
  'tool',
  'credential',
  'compute',
  'connection',
  'model',
]);
export type SupplyKind = z.infer<typeof SupplyKind>;

/**
 * The shape of the product a repository holds, when ORBOT started it from a template. Bots are
 * briefed with it; a deploy publishes its entry file.
 */
export const ProjectShape = z.object({
  /** One self-contained HTML file: no build step, no server. */
  kind: z.literal('single-html'),
  /** The product itself, relative to the repository root. */
  entry: z.string().min(1).default('index.html'),
});
export type ProjectShape = z.infer<typeof ProjectShape>;
export const ProjectKind = ProjectShape.shape.kind;
export type ProjectKind = z.infer<typeof ProjectKind>;

export const RepositorySupply = z.object({
  kind: z.literal('repository'),
  /** Local path or clone URL as given by the Commander. Credentials are never embedded. */
  location: z.string().min(1),
  /** Local clone the WorkspaceManager creates worktrees from. */
  localPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  /** What the repository holds, when ORBOT created it from a template. */
  project: ProjectShape.nullable().default(null),
});

export const CredentialSupply = z.object({
  kind: z.literal('credential'),
  /** Name of the secret in the secrets store. The value is never here. */
  secretName: z.string().min(1),
});

export const AppInstallStatus = z.enum(['installing', 'running', 'failed', 'removing', 'removed']);
export type AppInstallStatus = z.infer<typeof AppInstallStatus>;

/** One app on a server: what was installed with which settings, and how it is doing. */
export const ServerApp = z.object({
  id: Id,
  /** The app's folder in deploy/apps. */
  app: z.string().min(1),
  name: z.string().min(1),
  status: AppInstallStatus,
  /** Settings as given (never secrets). */
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** Secret settings, by credential name. */
  credentials: z.record(z.string(), z.string().nullable()),
  /** The step it is on (installing) or failed at, and why. */
  message: z.string().nullable().default(null),
  startedAt: z.string(),
  finishedAt: z.string().nullable().default(null),
  /** Depot items the app provides, e.g. the model it serves. */
  provides: z.array(Id).default([]),
  /** Its last status report (status.sh), redacted. */
  report: z.record(z.string(), z.string()).nullable().default(null),
});
export type ServerApp = z.infer<typeof ServerApp>;

/**
 * A server bots log in to over SSH. The private key is a credential, used by name; the host
 * keys seen when it was connected are pinned, so ORBOT talks to no other machine.
 */
export const ServerAccess = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
  /** The SSH private key, in the secrets store. */
  credentialName: z.string().min(1),
  /** known_hosts lines captured when the server was connected. */
  hostKeys: z.array(z.string()).min(1),
  /** The host key fingerprints, for the Commander to compare. */
  fingerprints: z.array(z.string()),
  /** Where the service on it can be seen, if anywhere. */
  url: z.string().nullable().default(null),
  /** rsync is installed on it (dev folders are kept in sync with it; otherwise tar). */
  rsync: z.boolean().default(false),
  /** What the server is (OS, GPU, Docker, sudo), as `deploy/server/facts.sh` reported it. */
  facts: z.record(z.string(), z.string()).nullable().default(null),
  /**
   * The bot workspace: a separate login without sudo for bots' dev work, so they cannot touch
   * the apps on the server. Its key is an ORBOT-generated credential.
   */
  workspace: z
    .object({ user: z.string().min(1), credentialName: z.string().min(1) })
    .nullable()
    .default(null),
  /** Apps ORBOT installed on it from `deploy/apps`. */
  apps: z.array(ServerApp).default([]),
});
export type ServerAccess = z.infer<typeof ServerAccess>;

/**
 * A static site: an environment with no server. ORBOT publishes the files itself into a folder
 * it serves, and keeps every earlier version beside them.
 */
export const StaticSite = z.object({
  /** The folder ORBOT publishes into, on its own machine. */
  dir: z.string().min(1),
  /** The file a visitor gets at the site's root. */
  entry: z.string().min(1).default('index.html'),
  /** The last publication, if any. */
  last: z
    .object({ commit: z.string(), at: z.string(), taskId: Id.nullable() })
    .nullable()
    .default(null),
});
export type StaticSite = z.infer<typeof StaticSite>;

export const GenericSupply = z.object({
  kind: z.enum(['environment', 'tool', 'compute']),
  /**
   * For environments: `tier` is `dev` (bots build and test there), `staging` or `production`
   * (production deploy rights are irreversible).
   */
  details: z.record(z.string(), z.string()),
  /** For environments that are servers: how bots log in. */
  server: ServerAccess.nullable().default(null),
  /** For environments that are static sites: where ORBOT publishes. Never both a server and a site. */
  site: StaticSite.nullable().default(null),
});

/**
 * A connection to an outside service for one of ORBOT's repositories: the code host (push
 * branches, open pull requests), the issue tracker (take issues on as missions, close them
 * when done) and the build pipeline (its result gates production deploys). The token is a
 * credential, referenced by name.
 */
export const ConnectionSupply = z.object({
  kind: z.literal('connection'),
  provider: z.enum(['github']),
  /** API base, e.g. https://api.github.com (or a GitHub Enterprise URL). */
  apiUrl: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** Where branches are pushed (a git remote URL without credentials). */
  pushUrl: z.string().min(1),
  /** The ORBOT repository (supply) this connection serves. */
  repoSupplyId: Id,
  credentialName: z.string().nullable(),
  services: z.object({ codeHost: z.boolean(), issues: z.boolean(), pipeline: z.boolean() }),
  /** Comment on and close an issue when the mission that took it on is done. */
  closeIssues: z.boolean().default(true),
});
export type ConnectionSupply = z.infer<typeof ConnectionSupply>;

/**
 * A language model bots can be given: an OpenAI-compatible endpoint (e.g. vLLM on one of the
 * Commander's servers). The API key is a credential, referenced by name.
 */
export const ModelSupply = z.object({
  kind: z.literal('model'),
  protocol: z.enum(['openai']),
  /** e.g. http://10.0.0.5:8000/v1 */
  baseUrl: z.string().min(1),
  /** The model name in API calls. */
  model: z.string().min(1),
  credentialName: z.string().nullable(),
  contextWindow: z.number().int().positive().nullable().default(null),
  /** Where it runs, when ORBOT installed it: the server and the app on it. */
  hostedOn: z.object({ supplyId: Id, appId: Id }).nullable().default(null),
});
export type ModelSupply = z.infer<typeof ModelSupply>;

export const SupplyBody = z.object({
  name: z.string().min(1),
  connected: z.boolean(),
  spec: z.discriminatedUnion('kind', [
    RepositorySupply,
    CredentialSupply,
    GenericSupply,
    ConnectionSupply,
    ModelSupply,
  ]),
});
export type SupplyBody = z.infer<typeof SupplyBody>;

// ---------- Documents ----------

export const DocumentKind = z.enum([
  'operation-record',
  'field-manual',
  'standing-orders',
  'handover',
  'after-action',
  'note',
  /** A recon report: what a bot found surveying the code for a question. */
  'recon',
  /** HQ's daily brief to the Commander. */
  'daily-brief',
]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const DocumentBody = z.object({
  kind: DocumentKind,
  unitId: Id.nullable(),
  title: z.string().min(1),
  markdown: z.string(),
  /** For handovers: the task the handover closes. */
  taskId: Id.nullable(),
  /** For operation records and After Action reviews. */
  operationId: Id.nullable().default(null),
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
  kind: TaskKind.default('work'),
  /** Which of the operation's repositories the task works in; null = the first. */
  repoSupplyId: Id.nullable().default(null),
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
// ---------- Dispute ----------

/** A ruling on a dispute: who prevails, why, and the standing orders it rests on. */
export const Ruling = z.object({
  prevails: z.enum(['raiser', 'other']),
  reasoning: z.string().min(1),
  cited: z.array(
    z.object({ unitId: Id.nullable(), orderId: z.string().nullable(), text: z.string() }),
  ),
  by: z.string(),
  at: z.iso.datetime({ offset: true }),
});
export type Ruling = z.infer<typeof Ruling>;

export const DisputeStatus = z.enum(['open', 'ruled', 'referred', 'final']);
export type DisputeStatus = z.infer<typeof DisputeStatus>;

/**
 * A disagreement between units, raised by a bot about its task. HQ rules under standing
 * orders (or refers it to the Commander when none settles it); the Commander has final say.
 */
export const DisputeBody = z.object({
  /** The unit that raised it. */
  unitId: Id,
  againstUnitId: Id,
  taskId: Id,
  botId: Id.nullable(),
  operationId: Id.nullable().default(null),
  claim: z.string().min(1),
  status: DisputeStatus,
  hqRuling: Ruling.nullable().default(null),
  commanderRuling: Ruling.nullable().default(null),
});
export type DisputeBody = z.infer<typeof DisputeBody>;

/** When stuck work goes up the chain (bot → Overseer → HQ → Commander). */
export const EscalationSettings = z.object({
  /** No entry on the record for this long while working: the Overseer checks in; twice: escalate. */
  stallSeconds: z.number().int().min(1).default(600),
  /** A single run longer than this is stopped with a handover and escalated. */
  timeoutSeconds: z.number().int().min(1).default(3600),
  /** A task that fails this many times is not retried; it goes up the chain. */
  repeatedFailures: z.number().int().min(1).default(2),
  /** A bot whose last this-many runs all failed is stood down and escalated. */
  failingBotRuns: z.number().int().min(2).default(3),
});
export type EscalationSettings = z.infer<typeof EscalationSettings>;
export const DEFAULT_ESCALATION: EscalationSettings = {
  stallSeconds: 600,
  timeoutSeconds: 3600,
  repeatedFailures: 2,
  failingBotRuns: 3,
};

/** When HQ writes the daily brief. */
export const DailyBriefSettings = z.object({
  enabled: z.boolean().default(true),
  /** Local time of day, HH:MM. */
  at: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('07:00'),
  /** IANA time zone the time is in, e.g. Europe/London. */
  timeZone: z.string().min(1).default('UTC'),
});
export type DailyBriefSettings = z.infer<typeof DailyBriefSettings>;
export const DEFAULT_DAILY_BRIEF: DailyBriefSettings = {
  enabled: true,
  at: '07:00',
  timeZone: 'UTC',
};

/** What can alert the Commander's phone. */
export const AlertKind = z.enum([
  'escalation',
  'approval',
  'deploy',
  'dispute',
  'budget',
  'sand-table',
  'daily-brief',
]);
export type AlertKind = z.infer<typeof AlertKind>;

/**
 * Phone alerts go to an ntfy-style push URL. The URL is a secret (whoever has it can read
 * the alerts), so only the name of the credential holding it is stored here.
 */
export const AlertSettings = z.object({
  enabled: z.boolean().default(false),
  credentialName: z.string().min(1).nullable().default(null),
  kinds: z
    .array(AlertKind)
    .default(['escalation', 'approval', 'deploy', 'dispute', 'budget', 'daily-brief']),
});
export type AlertSettings = z.infer<typeof AlertSettings>;
export const DEFAULT_ALERTS: AlertSettings = {
  enabled: false,
  credentialName: null,
  kinds: ['escalation', 'approval', 'deploy', 'dispute', 'budget', 'daily-brief'],
};

export const SettingsBody = z.object({
  /** Chat action kinds that need a typed one-line confirmation before they run. */
  irreversibleActions: z.array(z.string()),
  /** The phrase the Commander types to confirm an irreversible order. */
  confirmationPhrase: z.string().min(1),
  /** Share of a compute budget (0–1) at which ORBOT warns before the hard cap. */
  budgetWarnAt: z.number().min(0.1).max(1).default(0.8),
  escalation: EscalationSettings.default(DEFAULT_ESCALATION),
  /** "Everything, stand down": a stand-down order on every unit (Phase 5). */
  halt: Halt.nullable().default(null),
  /** The operation the force puts first, if any (Phase 5). */
  mainEffort: MainEffort.nullable().default(null),
  /** Whether running supporting work pauses (with a handover) to free a bot for the main effort. */
  mainEffortYield: z.boolean().default(true),
  dailyBrief: DailyBriefSettings.default(DEFAULT_DAILY_BRIEF),
  alerts: AlertSettings.default(DEFAULT_ALERTS),
});
export type SettingsBody = z.infer<typeof SettingsBody>;

/** Well-known id of the settings entity. */
export const SETTINGS_ID = '00000000-0000-4000-8000-000000000001';

export const DEFAULT_SETTINGS: SettingsBody = {
  irreversibleActions: ['grant-deploy-rights'],
  confirmationPhrase: 'confirm',
  budgetWarnAt: 0.8,
  escalation: DEFAULT_ESCALATION,
  halt: null,
  mainEffort: null,
  mainEffortYield: true,
  dailyBrief: DEFAULT_DAILY_BRIEF,
  alerts: DEFAULT_ALERTS,
};

// ---------- Officer ----------

/**
 * Another officer who can sign in. Their password is never on the record: it is hashed and
 * kept in the secrets store. Officers are never deleted; an officer who leaves is retired.
 */
export const OfficerBody = z.object({
  name: z.string().trim().min(1).max(100),
  /** What they sign in with: lowercase, unique. */
  login: z.string().regex(/^[a-z][a-z0-9._-]{1,39}$/),
  rank: Rank,
  /** For Captains: the units they command. */
  unitIds: z.array(Id).default([]),
  retired: z.boolean().default(false),
});
export type OfficerBody = z.infer<typeof OfficerBody>;

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
  dispute: DisputeBody,
  officer: OfficerBody,
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
  dispute: DisputeBody;
  officer: OfficerBody;
}

/** What a write may supply: defaulted fields are optional and filled in by the schema. */
export type EntityInputMap = { [K in EntityType]: z.input<(typeof ENTITY_BODY_SCHEMAS)[K]> };
