import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { BotEvent, BotRuntime, RunContext, TaskBrief } from '@orbot/shared';
import { git } from '../common/git.js';
import { loadScenarios, mulberry32, type Scenario, type ScenarioStep } from './scenario.js';

export const DEFAULT_SCENARIO = 'happy-path';

/**
 * Scripted, deterministic fake bots. No AI calls. Proves the command system
 * works (briefing, workspaces, record, policy, credentials), not code quality.
 */
export class SimulatedRuntime implements BotRuntime {
  readonly kind = 'simulated';
  private readonly scenarios: Map<string, Scenario>;

  constructor(scenarios?: Map<string, Scenario>) {
    this.scenarios = scenarios ?? loadScenarios();
  }

  scenarioIds(): string[] {
    return [...this.scenarios.keys()].sort();
  }

  async *run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent> {
    const scenarioId = brief.task.scenario ?? DEFAULT_SCENARIO;
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) {
      yield { type: 'failed', reason: `Unknown simulation scenario "${scenarioId}".` };
      return;
    }
    const rand = mulberry32(scenario.seed);
    const vars: Record<string, string> = {
      task: brief.task.title,
      number: String(brief.task.number),
      callsign: brief.bot.callsign,
      branch: brief.workspace.branch,
      unit: brief.unit.name,
    };
    const text = (t: string | string[]) => {
      const s = Array.isArray(t) ? t[Math.floor(rand() * t.length)]! : t;
      return s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
    };
    const credentialName = brief.task.credentialNames[0];

    for (const step of scenario.script) {
      if (ctx.signal.aborted) return;
      yield* this.perform(step, brief, ctx, text, credentialName);
      if (step.do === 'block' || step.do === 'fail' || step.do === 'done') return;
    }
  }

  private async *perform(
    step: ScenarioStep,
    brief: TaskBrief,
    ctx: RunContext,
    text: (t: string | string[]) => string,
    credentialName: string | undefined,
  ): AsyncIterable<BotEvent> {
    switch (step.do) {
      case 'step':
        yield {
          type: 'step',
          action: step.action,
          detail: text(step.detail),
          ...(step.outcome ? { outcome: text(step.outcome) } : {}),
        };
        return;
      case 'wait':
        await sleep(step.ms * ctx.timeScale, ctx.signal);
        return;
      case 'diary':
        yield { type: 'diary', category: step.category, text: text(step.text) };
        return;
      case 'sitrep':
        yield {
          type: 'sitrep',
          text: text(step.text),
          ...(step.status ? { status: step.status } : {}),
        };
        return;
      case 'write-file': {
        const rel = text(step.path);
        const target = resolve(brief.workspace.path, rel);
        if (relative(brief.workspace.path, target).startsWith('..')) {
          yield { type: 'failed', reason: `Refused to write outside the workspace: ${rel}` };
          return;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, text(step.content) + '\n', 'utf8');
        yield { type: 'step', action: 'write-file', detail: `Wrote ${rel}`, outcome: 'ok' };
        yield { type: 'artifact', kind: 'file', ref: rel, summary: `Edited ${rel}` };
        return;
      }
      case 'commit': {
        const message = text(step.message);
        await git(brief.workspace.path, ['add', '-A']);
        await git(brief.workspace.path, ['commit', '--quiet', '-m', message]);
        const sha = await git(brief.workspace.path, ['rev-parse', 'HEAD']);
        yield { type: 'step', action: 'commit', detail: message, outcome: sha };
        yield { type: 'artifact', kind: 'commit', ref: sha, summary: message };
        return;
      }
      case 'use-credential': {
        if (!credentialName) {
          yield {
            type: 'step',
            action: 'use-credential',
            detail: 'No credential issued for this task; skipped.',
            outcome: 'skipped',
          };
          return;
        }
        const purpose = text(step.purpose);
        // A real bot would hand the value to a tool (git push, API call). The
        // simulation only checks it was issued, then reports the use by name.
        await ctx.withCredential(credentialName, purpose, async (value) => {
          if (!value) throw new Error(`Credential ${credentialName} was empty.`);
        });
        yield {
          type: 'step',
          action: 'use-credential',
          detail: `Used ${credentialName} to ${purpose}`,
          outcome: 'ok',
        };
        return;
      }
      case 'cost':
        yield { type: 'cost', units: step.units };
        return;
      case 'block':
        yield { type: 'blocked', reason: text(step.reason) };
        return;
      case 'fail':
        yield { type: 'failed', reason: text(step.reason) };
        return;
      case 'handover':
        yield {
          type: 'handover',
          note: {
            state: text(step.state),
            nextSteps: step.nextSteps.map(text),
            triedAndFailed: step.triedAndFailed.map(text),
            openProblems: step.openProblems.map(text),
            flagsForSuccessor: step.flagsForSuccessor.map(text),
          },
        };
        return;
      case 'done':
        yield { type: 'done', summary: text(step.summary) };
        return;
      case 'leak-credential': {
        if (!credentialName) return;
        const leaked = await ctx.withCredential(
          credentialName,
          'debugging (rogue)',
          async (v) => v,
        );
        yield { type: 'diary', category: 'note', text: `The token is ${leaked}` };
        yield { type: 'sitrep', text: `Pushed using ${leaked}` };
        yield { type: 'step', action: 'debug', detail: `env TOKEN=${leaked}`, outcome: leaked };
        yield {
          type: 'handover',
          note: {
            state: `Credential value is ${leaked}`,
            nextSteps: [`Reuse ${leaked}`],
            triedAndFailed: [],
            openProblems: [],
            flagsForSuccessor: [Buffer.from(leaked).toString('base64')],
          },
        };
        return;
      }
      case 'crash-with-credential': {
        if (!credentialName) return;
        const v = await ctx.withCredential(credentialName, 'crash test', async (x) => x);
        throw new Error(`connection refused for token ${v}`);
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        res();
      },
      { once: true },
    );
  });
}
