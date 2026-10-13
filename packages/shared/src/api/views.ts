import type {
  BackbriefBody,
  BotBody,
  DisputeBody,
  FmEntryBody,
  Halt,
  MainEffort,
  DocumentBody,
  MissionBody,
  OperationBody,
  SupplyBody,
  TaskBody,
  UnitBody,
} from '../domain/entities.js';
import type { RecordEvent } from '../record/events.js';
import type { VersionWithStatus } from '../record/record.js';
import type { BotStatus, Status } from '../status/status.js';

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
  'blocked-bot' | 'failed-task' | 'awaiting-approval' | 'escalation' | 'budget' | 'dispute';

/** A compute budget and what has been spent against it. */
export interface BudgetView {
  /** Hard cap in units; null = no cap set. */
  cap: number | null;
  spent: number;
  /** Share (0–1) at which ORBOT warns. */
  warnAt: number;
  state: 'uncapped' | 'ok' | 'warning' | 'capped';
}

export interface AttentionItem {
  kind: AttentionKind;
  /** Something the Commander can do right there, e.g. approve a production deploy. */
  action?: 'approve-deploy' | 'acknowledge';
  /** For escalations: the chain to acknowledge. */
  chainId?: string;
  label: string;
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
  attention: (AttentionItem & { unitName: string })[];
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
}

export interface OperationDetailView extends OperationSummary {
  /** Phase changes, handoffs, send-backs, integration, deployment, HQ and unit sitreps. */
  timeline: RecordEvent[];
  record: DocumentView | null;
  afterAction: DocumentView | null;
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
export function budgetView(cap: number | null, spent: number, warnAt: number): BudgetView {
  const state =
    cap === null ? 'uncapped' : spent >= cap ? 'capped' : spent >= cap * warnAt ? 'warning' : 'ok';
  return { cap, spent, warnAt, state };
}

/** A dispute with the names of the units involved. */
export type DisputeView = Versioned<DisputeBody> & {
  unitName: string;
  againstUnitName: string;
  taskNumber: number;
  taskTitle: string;
  botCallsign: string | null;
};
