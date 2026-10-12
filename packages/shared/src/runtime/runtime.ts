import type { ProposedTask, TaskBody, Workspace } from '../domain/entities.js';
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
  unit: { id: string; name: string; standingOrders: string[] };
  workspace: Workspace;
  /** The last handover for this work (this task, or the one it continues). */
  lastHandover: BriefHandover | null;
  /** Field Manual entries relevant to the task, plus pinned ones. */
  fieldManual: BriefFieldManualEntry[];
  /** Recent War Diary entries from the unit. */
  recentDiary: BriefDiaryEntry[];
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
}

export interface LiveOrders {
  standingOrders: string[];
  supply: { name: string; kind: string }[];
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
  | { type: 'artifact'; kind: 'commit' | 'file'; ref: string; summary: string }
  | { type: 'cost'; units: number }
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
  mission: { id: string; goal: string; definitionOfDone: string[] };
  unit: { id: string; name: string; standingOrders: string[] };
  bots: { id: string; callsign: string; role: string; status: string; queueLength: number }[];
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
  supplyIds: string[];
  computeBudget: number;
  tasks: {
    id: string;
    number: number;
    title: string;
    status: string;
    statusReason: string | null;
    missionId: string | null;
    botCallsign: string | null;
  }[];
  missions: { id: string; goal: string; status: string; done: number; total: number }[];
}

export interface InterpretInput {
  message: string;
  /** The unit whose Overseer is being addressed, or null for HQ. */
  channelUnitId: string | null;
  units: InterpretUnit[];
  depot: { id: string; name: string; kind: string; connected: boolean; tier: string | null }[];
}
