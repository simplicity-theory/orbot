import type {
  BackbriefBody,
  BotBody,
  FmEntryBody,
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

export type AttentionKind = 'blocked-bot' | 'failed-task' | 'awaiting-approval' | 'escalation';

export interface AttentionItem {
  kind: AttentionKind;
  label: string;
  /** App route that resolves it, e.g. `/units/<id>/bots/<id>`. */
  link: string;
  entityId: string;
}

export interface OrbatUnit {
  unit: UnitView;
  overseer: BotView | null;
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
}

export interface MetaView {
  productName: string;
  runtime: string;
}
