import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DiaryCategory, TaskStatus } from '@orbot/shared';

/** Text with `{task}`, `{number}`, `{callsign}`, `{branch}`, `{unit}` placeholders, or a list to pick from. */
const Text = z.union([z.string(), z.array(z.string()).min(1)]);

export const ScenarioStep = z.discriminatedUnion('do', [
  z.object({ do: z.literal('step'), action: z.string(), detail: Text, outcome: Text.optional() }),
  z.object({ do: z.literal('wait'), ms: z.number().int().nonnegative() }),
  z.object({ do: z.literal('diary'), category: DiaryCategory, text: Text }),
  z.object({ do: z.literal('sitrep'), text: Text, status: TaskStatus.optional() }),
  z.object({ do: z.literal('write-file'), path: z.string(), content: Text }),
  z.object({ do: z.literal('commit'), message: Text }),
  z.object({ do: z.literal('use-credential'), purpose: Text }),
  z.object({ do: z.literal('cost'), units: z.number().nonnegative() }),
  z.object({ do: z.literal('block'), reason: Text }),
  z.object({ do: z.literal('fail'), reason: Text }),
  z.object({
    do: z.literal('handover'),
    state: Text,
    nextSteps: z.array(z.string()).default([]),
    triedAndFailed: z.array(z.string()).default([]),
    openProblems: z.array(z.string()).default([]),
    flagsForSuccessor: z.array(z.string()).default([]),
  }),
  z.object({ do: z.literal('done'), summary: Text }),
  /**
   * Test-only misbehaviour: the bot pastes the credential's value into its
   * diary, sitrep, working record and handover. The redaction layer must catch it.
   */
  z.object({ do: z.literal('leak-credential') }),
  /** Throws inside the runtime with the credential's value in the error message. */
  z.object({ do: z.literal('crash-with-credential') }),
  /** Stop part-way so another bot can pick the task up (after writing a handover). */
  z.object({ do: z.literal('stand-down'), reason: Text }),
  /** Block unless the brief carries a handover with next steps for this task. */
  z.object({ do: z.literal('require-handover'), missing: Text }),
  /**
   * Block unless the Field Manual (brief first, then a record search) contains `pattern`.
   * The pattern's first capture group becomes the variable `as`.
   */
  z.object({
    do: z.literal('require-field-manual'),
    pattern: z.string(),
    query: z.string(),
    as: z.string(),
    missing: Text,
  }),
  /** Carry out the handover's next steps of the form ``Write `path`: content``. */
  z.object({ do: z.literal('follow-handover') }),
  /**
   * Re-read the unit's live standing orders. While one matches `pattern` (it forbids going on),
   * wait up to `holdMs` (real time) for a frago, re-checking after each; then block with `blocked`.
   */
  z.object({
    do: z.literal('respect-order'),
    pattern: z.string(),
    holdMs: z.number().int().nonnegative().default(0),
    blocked: Text,
  }),
  /** Inspect the branch: send the work back unless a tracked file matches `pattern`. */
  z.object({
    do: z.literal('check-branch'),
    check: z.string(),
    pattern: z.string(),
    sendBack: Text,
  }),
  /** Deploy the workspace head to an environment (moves `deploy/<environment>` to it). */
  z.object({ do: z.literal('deploy'), environment: z.string() }),
  /** Block unless the unit's live supply has an item whose name matches `pattern`. */
  z.object({ do: z.literal('require-supply'), pattern: z.string(), missing: Text }),
]);
export type ScenarioStep = z.infer<typeof ScenarioStep>;

export const Scenario = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  seed: z.number().int(),
  script: z.array(ScenarioStep).min(1),
  /**
   * Played instead of `script` when the task's branch already has work on it
   * (someone started it before). Knowledge must come from the brief, not memory.
   */
  resume: z.array(ScenarioStep).optional(),
});
export type Scenario = z.infer<typeof Scenario>;

const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');

export function loadScenarios(dir = SCENARIO_DIR): Map<string, Scenario> {
  const out = new Map<string, Scenario>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const s = Scenario.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    out.set(s.id, s);
  }
  return out;
}

/** Small deterministic PRNG so a scenario always plays out the same way. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
