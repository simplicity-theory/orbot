import type {
  HoldPolicy,
  OperationNeed,
  ProjectShape,
  ProposedTask,
  RulesOfEngagement,
  TaskBody,
  Workspace,
} from '../domain/entities.js';
import type { Interpretation } from '../chat/chat.js';
import type { DiaryCategory } from '../record/events.js';
import type { TaskStatus } from '../status/status.js';

/**
 * Everything the rest of ORBOT knows about how bot work gets done.
 * Overseers, the record, chat and the UI talk only to this interface, so the
 * model behind a bot can be swapped without rewrites.
 */
export interface BotRuntime {
  /** Adapter id, e.g. `simulated` or `claude`. */
  readonly kind: string;
  /**
   * Execute one task. Yields events as the bot works; the caller records each
   * one (after a policy check) before pulling the next. Must stop promptly when
   * `ctx.signal` aborts.
   */
  run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent>;

  // ---- Overseer work. Overseers are bots too, so their thinking goes through the runtime. ----

  /** Turn a mission into a plan (tasks, assignments, risks) to brief back to the Commander. */
  draftBackbrief(input: BackbriefInput): Promise<BackbriefDraft>;
  /** Decide what a handover teaches the unit: promote, merge into, or retire Field Manual entries. */
  curate(input: CurationInput): Promise<CurationAction[]>;
  /** Given only the unit's documents, could a fresh bot continue this task? What is missing? */
  assessColdStart(input: ColdStartInput): Promise<ColdStartAssessment>;
  /** Read a Commander's chat message: answer it and/or turn it into typed actions. */
  interpret(input: InterpretInput): Promise<Interpretation>;

  // ---- HQ staff work ----

  /** O Group: split an operation's intent into one mission per unit, in handoff order. */
  planOperation(input: OperationPlanInput): Promise<OperationPlan>;
  /** After Action review: what went well, what to improve, lessons to keep as standing orders. */
  afterAction(input: AfterActionInput): Promise<AfterActionReview>;
  /** Rule on a dispute between two units, under their standing orders (null = none settles it). */
  ruleDispute(input: DisputeInput): Promise<DisputeRuling>;
}

// ---------- Briefing ----------

export interface BriefHandover {
  documentId: string;
  version: number;
  title: string;
  markdown: string;
}

export interface BriefFieldManualEntry {
  entryId: string;
  version: number;
  title: string;
  body: string;
}

/** A recon report the unit filed earlier, relevant to this work. */
export interface BriefRecon {
  documentId: string;
  title: string;
  markdown: string;
}

/** A decision on something the bot asked permission for. */
export interface BriefPermission {
  action: string;
  approved: boolean;
  note: string | null;
}

export interface BriefDiaryEntry {
  eventId: string;
  category: string;
  text: string;
  at: string;
}

/** What a bot is handed before starting: everything it needs, nothing it doesn't. */
export interface TaskBrief {
  runId: string;
  taskId: string;
  task: TaskBody;
  bot: { id: string; callsign: string; role: string };
  unit: {
    id: string;
    name: string;
    standingOrders: string[];
    /** What a bot may do without asking, and what it must ask permission for. */
    rulesOfEngagement: RulesOfEngagement;
    /** What holds the work for the Commander (the operation's override, else the unit's). */
    holdPolicy: HoldPolicy;
  };
  workspace: Workspace;
  /** The repository the task works in, and the shape of the product it holds (if templated). */
  repository: { name: string; project: ProjectShape | null } | null;
  /** Decisions on this task's permission requests, oldest first: the bot follows them. */
  permissions: BriefPermission[];
  /** The last handover for this work (this task, or the one it continues). */
  lastHandover: BriefHandover | null;
  /** Field Manual entries relevant to the task, plus pinned ones. */
  fieldManual: BriefFieldManualEntry[];
  /** Recent War Diary entries from the unit. */
  recentDiary: BriefDiaryEntry[];
  /** Rulings on disputes this task raised: the bot follows them. */
  rulings: { disputeId: string; text: string }[];
  /** The unit's recon reports that bear on this work. */
  recon: BriefRecon[];
}

export interface RecordSearchResult {
  title: string;
  snippet: string;
  archived: boolean;
}

export interface RunContext {
  signal: AbortSignal;
  /** Simulated-time multiplier (0 = instant). Real runtimes ignore it. */
  timeScale: number;
  /**
   * Use a credential by name. The value is passed only to `fn` and never
   * returned; the use is recorded by name. Throws if policy denies it.
   */
  withCredential<T>(
    secretName: string,
    purpose: string,
    fn: (value: string) => Promise<T>,
  ): Promise<T>;
  /** Search the unit's knowledge on demand: current versions first, the archive as fallback. */
  searchRecord(query: string): Promise<RecordSearchResult[]>;
  /** The unit's orders and supply as they stand right now (they can change mid-task). */
  orders(): Promise<LiveOrders>;
  /** Wait up to `ms` (real time) for a frago; resolves null on timeout or abort. */
  waitForFrago(ms: number): Promise<FragoNote | null>;
  /** Servers the unit holds (environments bots can log in to over SSH). */
  servers(): Promise<ServerInfo[]>;
  /** Run a shell command on a server the unit holds. Policy-checked and recorded. */
  serverRun(server: string, command: string): Promise<ServerResult>;
  /** Copy the task's committed work (HEAD of its branch) into a directory on a server. */
  serverUpload(server: string, remotePath: string): Promise<ServerResult>;
  /**
   * On a dev server (null = the unit's first): bring the bot's folder up to date with the
   * working tree (uncommitted edits too), then run the command in that folder.
   */
  devRun(server: string | null, command: string): Promise<ServerResult>;
  /** Copy a file or directory from the bot's folder on a dev server back into the workspace. */
  devFetch(server: string | null, path: string): Promise<ServerResult>;
  /** Static sites the unit holds: environments ORBOT publishes to itself, with no server. */
  sites(): Promise<SiteInfo[]>;
  /**
   * Publish files from the task's committed work (HEAD) to a static site the unit holds.
   * Policy-checked (production only inside an approved deploy) and recorded as a deployment.
   */
  publish(site: string, paths: string[]): Promise<ServerResult>;
}

export interface SiteInfo {
  name: string;
  tier: string;
  /** Where the site is served. */
  url: string;
  /** The file served at its root. */
  entry: string;
  /** The commit published last, if any. */
  lastCommit: string | null;
}

export interface ServerInfo {
  name: string;
  tier: string;
  host: string;
  user: string;
  url: string | null;
  /** The user dev_run works as (the bot workspace, once set up). */
  devUser: string;
  gpu: string | null;
  /** Apps running on it: the admin login is then for approved deploys only. */
  apps: string[];
}

export interface ServerResult {
  exitCode: number | null;
  output: string;
}

export interface LiveOrders {
  standingOrders: string[];
  rulesOfEngagement: RulesOfEngagement;
  /** `tier` is set for environments (dev, staging, production). */
  supply: { name: string; kind: string; tier: string | null }[];
}

export interface FragoNote {
  text: string;
  at: string;
}

export interface HandoverNote {
  state: string;
  nextSteps: string[];
  triedAndFailed: string[];
  openProblems: string[];
  flagsForSuccessor: string[];
}

export type BotEvent =
  | { type: 'step'; action: string; detail: string; outcome?: string }
  | { type: 'diary'; category: DiaryCategory; text: string }
  | { type: 'sitrep'; text: string; status?: TaskStatus }
  | { type: 'artifact'; kind: 'commit' | 'file' | 'deployment'; ref: string; summary: string }
  /** The bot disagrees with another unit (named) about this work: HQ rules on it. */
  | { type: 'dispute'; against: string; claim: string }
  /**
   * The bot needs to do something its rules of engagement say it must escalate: the task
   * waits for the Commander's decision, then resumes with it in the brief.
   */
  | { type: 'permission'; action: string; rule: string; reason: string }
  /** A check failed: send the work back to the unit that handed it over. */
  | { type: 'send-back'; reason: string }
  | { type: 'cost'; units: number }
  /** A report (recon findings): filed as a unit document. */
  | { type: 'report'; title: string; markdown: string }
  | { type: 'blocked'; reason: string }
  /** The bot stops part-way (handed over) so another bot can pick the task up. */
  | { type: 'stood-down'; reason: string }
  | { type: 'handover'; note: HandoverNote }
  | { type: 'done'; summary: string }
  | { type: 'failed'; reason: string };

export type BotEventType = BotEvent['type'];

export function renderHandoverMarkdown(title: string, n: HandoverNote): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : '- None';
  return [
    `# Handover: ${title}`,
    '',
    '## State',
    n.state,
    '',
    '## Next steps',
    list(n.nextSteps),
    '',
    '## Tried and failed',
    list(n.triedAndFailed),
    '',
    '## Open problems',
    list(n.openProblems),
    '',
    '## Flags for a successor',
    list(n.flagsForSuccessor),
    '',
  ].join('\n');
}

/** Inverse of `renderHandoverMarkdown`, tolerant of human edits. */
export function parseHandoverMarkdown(md: string): HandoverNote {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of md.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1]!.toLowerCase();
      sections.set(current, []);
    } else if (current) {
      sections.get(current)!.push(line);
    }
  }
  const items = (name: string) =>
    (sections.get(name) ?? [])
      .map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim())
      .filter((x): x is string => !!x && x.toLowerCase() !== 'none');
  return {
    state: (sections.get('state') ?? []).join('\n').trim(),
    nextSteps: items('next steps'),
    triedAndFailed: items('tried and failed'),
    openProblems: items('open problems'),
    flagsForSuccessor: items('flags for a successor'),
  };
}

// ---------- Overseer inputs and outputs ----------

export interface BackbriefInput {
  /** `stage` is set for missions that are part of an operation's handoff chain. */
  mission: {
    id: string;
    goal: string;
    definitionOfDone: string[];
    stage: 'build' | 'inspect' | 'guard' | 'deploy' | null;
  };
  unit: { id: string; name: string; standingOrders: string[] };
  bots: { id: string; callsign: string; role: string; status: string; queueLength: number }[];
  /**
   * Where the work can land: the operation's repositories (the first is the default), or the
   * unit's own. A proposed task may name one by id.
   */
  repositories: { id: string; name: string; project?: ProjectShape | null }[];
  fieldManual: BriefFieldManualEntry[];
  /** Notes from the Commander on earlier rounds (when the plan was sent back). */
  commanderNotes: string[];
  round: number;
}

export interface BackbriefDraft {
  summary: string;
  proposedTasks: ProposedTask[];
  risks: string[];
}

export interface CurationInput {
  unit: { id: string; name: string };
  handover: { documentId: string; version: number; taskNumber: number | null; markdown: string };
  entries: { entryId: string; title: string; body: string; tags: string[] }[];
}

export type CurationAction =
  | { kind: 'promote'; title: string; body: string; tags: string[]; reason: string }
  | { kind: 'merge'; entryId: string; body: string | null; reason: string }
  | { kind: 'retire'; entryId: string; reason: string };

export interface ColdStartInput {
  unit: { id: string; name: string };
  task: { id: string; number: number; title: string; status: string } | null;
  lastHandover: BriefHandover | null;
  fieldManual: BriefFieldManualEntry[];
  recentDiary: BriefDiaryEntry[];
}

export interface ColdStartGap {
  description: string;
  /** A Field Manual entry that would close the gap, if the Overseer can write one. */
  suggestedEntry: { title: string; body: string } | null;
}

export interface ColdStartAssessment {
  /** 0–100: how confidently a fresh bot could continue from the documents alone. */
  score: number;
  gaps: ColdStartGap[];
}

export interface InterpretUnit {
  id: string;
  name: string;
  slug: string;
  standingOrders: { id: string; text: string }[];
  holdPolicy: HoldPolicy;
  supplyIds: string[];
  computeBudget: number;
  /** Whether a stand-down order is in force on the unit. */
  halted: boolean;
  bots: { id: string; callsign: string; status: string; halted: boolean }[];
  tasks: {
    id: string;
    number: number;
    title: string;
    status: string;
    statusReason: string | null;
    missionId: string | null;
    botCallsign: string | null;
    kind: string;
  }[];
  missions: { id: string; goal: string; status: string; done: number; total: number }[];
}

export interface InterpretInput {
  message: string;
  /**
   * The channel's recent turns before this message, oldest first: what the Commander said and
   * what the Overseer answered or proposed. A short reply ("Do it", "Yes") refers to the last
   * proposal here.
   */
  history: {
    from: 'commander' | 'overseer' | 'hq';
    text: string;
    /** What the Overseer proposed and is waiting for the Commander to confirm. */
    proposed?: string[];
  }[];
  /** The unit whose Overseer is being addressed, or null for HQ. */
  channelUnitId: string | null;
  units: InterpretUnit[];
  depot: { id: string; name: string; kind: string; connected: boolean; tier: string | null }[];
  /** Operations, with the depot items assigned to them (ids, from `depot`). */
  operations: {
    id: string;
    name: string;
    phase: string;
    supplyIds?: string[];
    holdPolicy?: HoldPolicy | null;
  }[];
  /** Whether "everything, stand down" is in force. */
  allHalted: boolean;
  /** The operation that is the main effort, if any. */
  mainEffortOperationId?: string | null;
  /** Connected issue trackers. */
  trackers?: { id: string; name: string }[];
}

export interface OperationPlanInput {
  name: string;
  intent: string;
  /** Recon reports filed for this operation before planning. */
  recon?: { unit: string; title: string; markdown: string }[];
  units: { id: string; name: string; role: string; standingMission: string }[];
  /** Resources the Commander already assigned to the operation. */
  resources: { name: string; kind: string; project?: ProjectShape | null }[];
}

export interface OperationPlan {
  name: string;
  missions: {
    unitId: string;
    stage: 'build' | 'inspect' | 'guard' | 'deploy';
    goal: string;
    definitionOfDone: string[];
  }[];
  /**
   * What else the operation needs from the Supply Depot beyond a repository (always needed) and,
   * for a deploy mission, a production environment (added by HQ), e.g. a GPU dev server.
   */
  needs?: OperationNeed[];
}

export interface AfterActionInput {
  operation: { name: string; intent: string };
  units: { id: string; name: string }[];
  /** What happened, in order: sitreps, handoffs, send-backs, blocks, the deployment. */
  timeline: { at: string; unit: string | null; kind: string; text: string }[];
}

export interface AfterActionReview {
  summary: string;
  wentWell: string[];
  toImprove: string[];
  /** Lessons saved as standing orders (unitId null = every unit). */
  lessons: { unitId: string | null; text: string }[];
}

export interface DisputeInput {
  claim: string;
  raiser: { id: string; name: string; standingOrders: { id: string; text: string }[] };
  other: { id: string; name: string; standingOrders: { id: string; text: string }[] };
  task: { number: number; title: string; description: string };
}

export interface DisputeRuling {
  /** Who prevails; null when no standing order settles it (HQ refers it to the Commander). */
  prevails: 'raiser' | 'other' | null;
  reasoning: string;
  cited: { unitId: string | null; orderId: string | null; text: string }[];
}
