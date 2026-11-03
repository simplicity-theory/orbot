import type {
  BackbriefBody,
  BotBody,
  DisputeBody,
  FmEntryBody,
  Halt,
  MainEffort,
  OfficerBody,
  DocumentBody,
  MissionBody,
  OperationBody,
  SupplyBody,
  TaskBody,
  TaskPermission,
  UnitBody,
  OperationNeed,
} from '../domain/entities.js';
import type { AppManifest } from '../domain/apps.js';
import type { RecordEvent } from '../record/events.js';
import type { DiffLine, VersionWithStatus } from '../record/record.js';
import type { BotStatus, Status } from '../status/status.js';
import type { Principal, Rank } from '../domain/principal.js';

/** The current version of an entity, flattened for the UI. */
export type Versioned<B> = B & {
  id: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
};

export type UnitView = Versioned<UnitBody>;
export type BotView = Versioned<BotBody>;
export type TaskView = Versioned<TaskBody>;
export type MissionView = Versioned<MissionBody>;
export type OperationView = Versioned<OperationBody>;

/** What starting a project made: its repository, its site, and (with an intent) its operation. */
export interface NewProjectView {
  repository: SupplyView;
  site: SupplyView;
  operation: OperationView | null;
}
export type DocumentView = Versioned<DocumentBody>;
/** Supply as the UI sees it. Credential supply carries only the secret's name. */
export type SupplyView = Versioned<SupplyBody>;
export type FmEntryView = Versioned<FmEntryBody>;

export interface BackbriefView extends Versioned<BackbriefBody> {
  mission: MissionView;
  unitName: string;
  /** Callsigns of the bots the plan mentions, for display. */
  callsigns: Record<string, string>;
}

export interface MissionProgress {
  mission: MissionView;
  done: number;
  total: number;
  backbrief: BackbriefView | null;
}

export type AttentionKind =
  | 'blocked-bot'
  | 'failed-task'
  | 'awaiting-approval'
  | 'escalation'
  | 'budget'
  | 'dispute'
  | 'sand-table'
  | 'resources';

/** A compute budget and what has been spent against it. */
export interface BudgetView {
  /** Hard cap in units; null = no cap set. */
  cap: number | null;
  spent: number;
  /** Share (0–1) at which ORBOT warns. */
  warnAt: number;
  state: 'uncapped' | 'ok' | 'warning' | 'capped';
  /** False while compute limits are off (settings): the cap is advisory and nothing is held. */
  enforced: boolean;
}

/** A task's branch landed on its repository's default branch. */
export interface LandedView {
  taskId: string;
  number: number;
  repository: string;
  /** The default branch landed on, and the task branch it came from. */
  branch: string;
  from: string;
  commit: string;
  /** True when the default branch already had everything. */
  unchanged: boolean;
}

/** "Restart the queues": the tasks queued again, and how many units were told to dispatch. */
export interface QueuesRestartView {
  requeued: {
    taskId: string;
    number: number;
    unitId: string;
    unitName: string;
    botCallsign: string | null;
  }[];
  units: number;
}

/** Compute spent so far, by task, unit and operation: the baseline for setting limits (D114). */
export interface ComputeUsageView {
  limits: 'off' | 'on';
  total: number;
  units: { id: string; name: string; spent: number; cap: number | null }[];
  operations: { id: string; name: string; phase: string; spent: number; cap: number | null }[];
  /** The costliest tasks, most expensive first. */
  tasks: {
    id: string;
    number: number;
    title: string;
    unitId: string;
    unitName: string;
    botId: string | null;
    status: string;
    spent: number;
    limit: number | null;
  }[];
}

export interface AttentionItem {
  kind: AttentionKind;
  /** Something the Commander can do right there, e.g. approve a production deploy. */
  action?: 'approve-deploy' | 'decide-permission' | 'acknowledge';
  /** For permission requests: what the bot asked, under which rule, and why. */
  permission?: TaskPermission;
  /** For escalations: the chain to acknowledge. */
  chainId?: string;
  label: string;
  /** What the Commander can do about it (a held or failed task's `statusAction`). */
  next?: string;
  /** App route that resolves it, e.g. `/units/<id>/bots/<id>`. */
  link: string;
  entityId: string;
}

export interface OrbatUnit {
  unit: UnitView;
  overseer: BotView | null;
  budget: BudgetView;
  botCount: number;
  botsByStatus: Partial<Record<BotStatus, number>>;
  currentMission: MissionView | null;
  status: Status;
  attention: AttentionItem[];
  /** Backbriefs waiting on the Commander, approvable inline from the ORBAT. */
  backbriefs: BackbriefView[];
  /** The unit's bots (not its Overseer), for the tree view. */
  bots: BotWithTask[];
}

export interface OrbatView {
  productName: string;
  units: OrbatUnit[];
  needsYou: number;
}

export interface BotWithTask extends BotView {
  currentTask: TaskView | null;
}

export interface UnitDetailView {
  unit: UnitView;
  status: Status;
  budget: BudgetView;
  overseer: BotView | null;
  bots: BotWithTask[];
  missions: MissionProgress[];
  tasks: TaskView[];
  /** Tasks waiting for a bot, in dispatch order. */
  queue: TaskView[];
  documents: DocumentView[];
  handovers: DocumentView[];
  fieldManual: FmEntryView[];
  retiredEntries: FmEntryView[];
  warDiary: RecordEvent[];
  supply: SupplyView[];
  attention: AttentionItem[];
  backbriefs: BackbriefView[];
  coldStart: RecordEvent<'coldstart.check'> | null;
  /** Where the unit's documents are mirrored as Markdown, if it has a repository. */
  docsMirror: { repository: string; branch: string; path: string } | null;
}

export interface ApprovalsView {
  backbriefs: BackbriefView[];
  /** `unitId` is null for HQ's own items, such as an operation waiting for resources. */
  attention: (AttentionItem & { unitName: string; unitId: string | null })[];
}

export interface PaletteItem {
  kind: 'unit' | 'bot' | 'task' | 'operation' | 'document' | 'mission';
  id: string;
  label: string;
  sublabel: string;
  link: string;
}

export interface BotDetailView {
  bot: BotView;
  unit: UnitView;
  currentTask: TaskView | null;
  queue: TaskView[];
  history: TaskView[];
  recent: RecordEvent[];
  /** What the bot was handed at the start of its latest run. */
  lastBrief: RecordEvent<'task.briefed'> | null;
  /** Other bots in the unit (not the Overseer), for reassigning work. */
  peers: BotView[];
}

export interface TaskDetailView {
  task: TaskView;
  unit: UnitView;
  bot: BotView | null;
  mission: MissionView | null;
  /** The operation the mission belongs to, for the chain of command on the task. */
  operation: OperationView | null;
  /** Every task of the mission in number order (this one among them). */
  missionTasks: TaskView[];
  events: RecordEvent[];
  versions: VersionWithStatus[];
  handover: DocumentView | null;
  /** For recon tasks: the report filed. */
  report: DocumentView | null;
  /** Files this task changes that other active tasks change too (deconfliction). */
  overlaps: TouchOverlap[];
}

/** A task touching a file: who, where, doing what. */
export interface Toucher {
  taskId: string;
  number: number;
  title: string;
  status: string;
  unitId: string;
  unitName: string;
  botId: string | null;
  callsign: string | null;
  branch: string;
}

export interface TouchOverlap {
  path: string;
  others: Toucher[];
}

/** HQ's map of who touches what: every file an active task changes, per repository. */
export interface DeconflictionView {
  repos: {
    id: string;
    name: string;
    files: { path: string; tasks: Toucher[] }[];
  }[];
  /** Files changed by more than one active task. */
  overlaps: number;
  /** HQ's deconfliction notices, newest last. */
  notices: RecordEvent[];
}

export interface MetaView {
  productName: string;
  /** Default runtime for new bots. */
  runtime: string;
  /** Runtimes installed (Claude appears when an API key is configured). */
  runtimes: string[];
  claudeModel: string;
}

export interface ChatView {
  channel: string;
  /** "Engineers Overseer (E-0)" or "HQ". */
  label: string;
  unitId: string | null;
  /** chat.message and chat.readback events, oldest first. */
  items: RecordEvent[];
  /** Orders-log entries that have been undone: entry id → the entry that reversed it. */
  reversed: Record<string, string>;
  /** Pending actions that were answered: pending id → outcome. */
  resolved: Record<string, 'confirmed' | 'declined'>;
}

export interface ChatSendResult {
  message: RecordEvent<'chat.message'>;
  readback: RecordEvent<'chat.readback'>;
}

export interface OrdersLogEntryView {
  entry: RecordEvent<'orders.log'>;
  reversedBy: string | null;
  /** The Commander message that caused it (null for undos). */
  message: RecordEvent<'chat.message'> | null;
  unitName: string;
}

export interface OperationMissionView {
  mission: MissionView;
  unit: UnitView;
  done: number;
  total: number;
  tasks: TaskView[];
  backbrief: BackbriefView | null;
}

export interface OperationSummary {
  operation: OperationView;
  budget: BudgetView;
  missions: OperationMissionView[];
  /** Things on this operation waiting on the Commander. */
  needsYou: AttentionItem[];
  resources: OperationResourcesView;
}

/** What an operation needs, what is assigned to it, and what is missing. */
export interface OperationResourcesView {
  needs: { need: OperationNeed; metBy: string[] }[];
  assigned: SupplyView[];
  /** Where the work lands, is handed off and deploys from (the first repository assigned). */
  mainRepositoryId: string | null;
  /** Required needs nothing assigned meets: the operation holds at the O Group until they are. */
  missing: OperationNeed[];
  /** It is waiting at the O Group for them. */
  blocked: boolean;
}

export interface OperationDetailView extends OperationSummary {
  /** Phase changes, handoffs, send-backs, integration, deployment, HQ and unit sitreps. */
  timeline: RecordEvent[];
  record: DocumentView | null;
  afterAction: DocumentView | null;
  /** The latest sand-table rehearsal of the plan, if any. */
  sandTable: RecordEvent<'sand-table'> | null;
}

/** The main effort, for the ORBAT strip, the operations board and task badges. */
export interface MainEffortView {
  mainEffort: MainEffort | null;
  operation: { id: string; name: string; phase: string } | null;
  /** Missions of the main-effort operation: their tasks go first. */
  missionIds: string[];
  /** Whether supporting work pauses to free a bot for it. */
  yieldEnabled: boolean;
}

/** Every stand-down order in force, for the banner and the Stand down controls. */
export interface StandDownView {
  all: Halt | null;
  units: { id: string; name: string; halt: Halt }[];
  bots: { id: string; callsign: string; unitId: string; halt: Halt }[];
}

/** Work out a budget's state from its cap, spend and warning share. */
export function budgetView(
  cap: number | null,
  spent: number,
  warnAt: number,
  enforced = true,
): BudgetView {
  const state =
    cap === null || !enforced
      ? 'uncapped'
      : spent >= cap
        ? 'capped'
        : spent >= cap * warnAt
          ? 'warning'
          : 'ok';
  return { cap, spent, warnAt, state, enforced };
}

/** A dispute with the names of the units involved. */
export type DisputeView = Versioned<DisputeBody> & {
  unitName: string;
  againstUnitName: string;
  taskNumber: number;
  taskTitle: string;
  botCallsign: string | null;
};

/** The daily briefs: the latest in full, and the dates of earlier ones. */
export interface DailyBriefView {
  latest: DocumentView | null;
  earlier: { id: string; title: string; createdAt: string }[];
  /** When the next one is due (ISO), or null if switched off. */
  nextAt: string | null;
}

/** A bot's service record: what it has done and how, worked out from the permanent record. */
export interface ServiceRecordView {
  bot: BotView;
  unitName: string;
  enlisted: { at: string; by: string; reason: string };
  replaces: { id: string; callsign: string } | null;
  replacedBy: { id: string; callsign: string } | null;
  stats: {
    runs: number;
    /** Runs by how they ended. */
    outcomes: { done: number; failed: number; blocked: number; stopped: number };
    tasksDone: number;
    /** Share of finished runs that ended done (0-1), or null before any run ends. */
    successRate: number | null;
    /** Average run length in seconds, or null. */
    averageRunSeconds: number | null;
    unitsSpent: number;
    handovers: number;
    diaryEntries: number;
    sitreps: number;
    reports: number;
    disputesRaised: number;
    escalations: number;
    /** Things policy refused it (rules of engagement, budgets, separation of duties…). */
    refusals: number;
  };
  /** Field Manual entries that came from its handovers: lessons it left the unit. */
  commendations: { entryId: string; title: string; at: string; retired: boolean }[];
  /** Notable entries, newest first. */
  entries: { at: string; kind: string; text: string; link: string | null }[];
}

export type OfficerView = Versioned<OfficerBody>;

/** Who is signed in, and what they may command. */
export interface MeView {
  principal: Principal;
  rank: Rank;
  /** Units a Captain commands; every unit for the Commander; none for an Observer. */
  unitIds: string[] | 'all';
}

/** An open issue on a connected tracker, and the mission that took it on (if any). */
export interface IssueView {
  number: number;
  title: string;
  url: string;
  labels: string[];
  taken: { missionId: string; unitId: string; unitName: string } | null;
}

/** A connected service: what it has done lately. */
export interface ConnectionView {
  supply: SupplyView;
  repositoryName: string;
  pullRequests: RecordEvent<'connection.pr'>[];
  /** Latest pipeline result per branch. */
  pipelines: RecordEvent<'pipeline.status'>[];
  errors: RecordEvent<'connection.error'>[];
}

/** A server's page: the server, what happened on it, and the apps that can be installed. */
export interface ServerDetailView {
  supply: SupplyView;
  /** Installs, the workspace and commands run on it, newest last. */
  events: RecordEvent<'app.install' | 'server.command' | 'server.workspace' | 'server.health'>[];
  catalog: AppManifest[];
  /** The last health check, if any. */
  health: RecordEvent<'server.health'> | null;
}

/** An install in progress, read live from the server (redacted). */
export interface AppProgressView {
  /** running <step> | done | failed <step>: <why> | removed | missing */
  state: string;
  /** The unit that runs it is still active on the server. */
  active: boolean;
  log: string;
}

/** A model endpoint answered (or not). */
export interface ModelCheckView {
  ok: boolean;
  /** The models it serves. */
  models: string[];
  message: string;
}

// ---------- Code: commits and diffs in the operation's repositories ----------

/** Who made a commit, from the record: the task (and bot, unit, operation) it belongs to. */
export interface CommitOrigin {
  /** `commit` a bot made; `integration`/`handoff`/`deployment` HQ recorded at that commit. */
  kind: 'commit' | 'integration' | 'handoff' | 'deployment';
  taskId: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
  unitId: string | null;
  unitName: string | null;
  botId: string | null;
  botCallsign: string | null;
  operationId: string | null;
  operationName: string | null;
}

export interface CommitSummary {
  sha: string;
  subject: string;
  author: string;
  date: string;
  parents: string[];
  /** Branches whose tip it is. */
  refs: string[];
  origin: CommitOrigin | null;
}

export interface DiffHunk {
  /** `@@ -12,7 +12,9 @@ function name` */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  /** For a rename or copy: where it came from. */
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** Too long to show in full: the first lines only. */
  truncated: boolean;
}

export interface RepositoryRef {
  id: string;
  name: string;
}

export interface CommitDetailView {
  repository: RepositoryRef;
  commit: CommitSummary;
  /** The message after the subject line. */
  body: string;
  /** Against its first parent (a merge shows what it brought in). */
  files: FileDiff[];
  /** More files changed than are shown. */
  truncated: boolean;
}

export interface TaskChangesView {
  repository: RepositoryRef | null;
  branch: string | null;
  /** Where the task branched from (its base). */
  base: string | null;
  /** The task's own commits, oldest first. */
  commits: CommitSummary[];
  /** Everything the task changed since its base, committed. */
  files: FileDiff[];
  /** Changes in its worktree not committed yet. */
  uncommitted: FileDiff[];
  truncated: boolean;
}

export interface RepositoryHistoryView {
  repository: RepositoryRef & { defaultBranch: string };
  /** Branches to look at: the default one, operations' integration branches, tasks' branches. */
  refs: { name: string; kind: 'default' | 'operation' | 'task' | 'other' }[];
  ref: string;
  commits: CommitSummary[];
}
