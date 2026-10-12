import type {
  BotBody,
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
  missions: MissionView[];
  tasks: TaskView[];
  documents: DocumentView[];
  supply: SupplyView[];
  attention: AttentionItem[];
}

export interface BotDetailView {
  bot: BotView;
  unit: UnitView;
  currentTask: TaskView | null;
  queue: TaskView[];
  history: TaskView[];
  recent: RecordEvent[];
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
