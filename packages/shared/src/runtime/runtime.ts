import type { DocumentBody, TaskBody, Workspace } from '../domain/entities.js';
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
}

/** What a bot is handed before starting: everything it needs, nothing it doesn't. */
export interface TaskBrief {
  runId: string;
  taskId: string;
  task: TaskBody;
  bot: { id: string; callsign: string; role: string };
  unit: { id: string; name: string; standingOrders: string[] };
  workspace: Workspace;
  /** Phase 2 fills these from the unit's documents. */
  lastHandover: DocumentBody | null;
  fieldManual: string[];
  recentDiary: string[];
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
