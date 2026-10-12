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
]);
export type ScenarioStep = z.infer<typeof ScenarioStep>;

export const Scenario = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  seed: z.number().int(),
  script: z.array(ScenarioStep).min(1),
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
