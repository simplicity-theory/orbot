import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import {
  parseHandoverMarkdown,
  type BackbriefDraft,
  type BackbriefInput,
  type BotEvent,
  type BotRuntime,
  type ColdStartAssessment,
  type ColdStartInput,
  type CurationAction,
  type CurationInput,
  type HandoverNote,
  type AfterActionInput,
  type AfterActionReview,
  type DisputeInput,
  type DisputeRuling,
  type InterpretInput,
  type OperationPlan,
  type OperationPlanInput,
  type Interpretation,
  type RunContext,
  type TaskBrief,
} from '@orbot/shared';
import { git } from '../common/git.js';
import { loadScenarios, mulberry32, type Scenario, type ScenarioStep } from './scenario.js';
import { SimulatedInterpreter } from './simulated-interpreter.js';
import { SimulatedOverseer } from './simulated-overseer.js';

export const DEFAULT_SCENARIO = 'happy-path';

interface RunState {
  vars: Record<string, string>;
  handover: HandoverNote | null;
}

/** Steps after which the run is over. */
type Stop = boolean;

/**
 * Scripted, deterministic fake bots. No AI calls. Proves the command system
 * works (briefing, workspaces, record, policy, credentials), not code quality.
 * Also plays the Overseer's part (planning, curation, cold-start checks) by rule.
 */
export class SimulatedRuntime implements BotRuntime {
  readonly kind = 'simulated';
  private readonly scenarios: Map<string, Scenario>;
  private readonly overseer = new SimulatedOverseer();
  private readonly interpreter = new SimulatedInterpreter();

  constructor(scenarios?: Map<string, Scenario>) {
    this.scenarios = scenarios ?? loadScenarios();
  }

  scenarioIds(): string[] {
    return [...this.scenarios.keys()].sort();
  }

  draftBackbrief(input: BackbriefInput): Promise<BackbriefDraft> {
    return Promise.resolve(this.overseer.draftBackbrief(input));
  }

  curate(input: CurationInput): Promise<CurationAction[]> {
    return Promise.resolve(this.overseer.curate(input));
  }

  assessColdStart(input: ColdStartInput): Promise<ColdStartAssessment> {
    return Promise.resolve(this.overseer.assessColdStart(input));
  }

  planOperation(input: OperationPlanInput): Promise<OperationPlan> {
    return Promise.resolve(this.overseer.planOperation(input));
  }

  afterAction(input: AfterActionInput): Promise<AfterActionReview> {
    return Promise.resolve(this.overseer.afterAction(input));
  }

  ruleDispute(input: DisputeInput): Promise<DisputeRuling> {
    return Promise.resolve(this.overseer.ruleDispute(input));
  }

  interpret(input: InterpretInput): Promise<Interpretation> {
    return Promise.resolve(this.interpreter.interpret(input));
  }

  async *run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent> {
    const scenarioId = brief.task.scenario ?? DEFAULT_SCENARIO;
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) {
      yield { type: 'failed', reason: `Unknown simulation scenario "${scenarioId}".` };
      return;
    }
    const rand = mulberry32(scenario.seed);
    const state: RunState = {
      vars: {
        task: brief.task.title,
        number: String(brief.task.number),
        callsign: brief.bot.callsign,
        branch: brief.workspace.branch,
        unit: brief.unit.name,
        description: brief.task.description,
      },
      handover: null,
    };
    const text = (t: string | string[]) => {
      const s = Array.isArray(t) ? t[Math.floor(rand() * t.length)]! : t;
      return s.replace(/\{(\w+)\}/g, (m, k: string) => state.vars[k] ?? m);
    };

    // The branch is the only thing a bot inherits physically. What was done, and
    // how this unit works, must come from the brief: the unit's documents.
    const resuming = !!scenario.resume && (await hasWorkOnBranch(brief));
    const script = resuming ? scenario.resume! : scenario.script;
    if (resuming) {
      yield {
        type: 'step',
        action: 'resume',
        detail: `Branch ${brief.workspace.branch} already has work on it; picking up from the brief.`,
      };
    }

    for (const step of script) {
      if (ctx.signal.aborted) return;
      const stop = yield* this.perform(step, brief, ctx, text, state);
      if (stop) return;
    }
  }

  private async *perform(
    step: ScenarioStep,
    brief: TaskBrief,
    ctx: RunContext,
    text: (t: string | string[]) => string,
    state: RunState,
  ): AsyncGenerator<BotEvent, Stop> {
    const credentialName = brief.task.credentialNames[0];
    switch (step.do) {
      case 'step':
        yield {
          type: 'step',
          action: step.action,
          detail: text(step.detail),
          ...(step.outcome ? { outcome: text(step.outcome) } : {}),
        };
        return false;
      case 'wait':
        await sleep(step.ms * ctx.timeScale, ctx.signal);
        return false;
      case 'dispute':
        if (brief.rulings.length) {
          // Ruled on: follow the ruling and carry on.
          for (const r of brief.rulings)
            yield { type: 'step', action: 'read-ruling', detail: r.text, outcome: 'will comply' };
          return false;
        }
        yield { type: 'dispute', against: text(step.against), claim: text(step.claim) };
        return true;
      case 'hold':
        if (brief.lastHandover) return false;
        await sleep(step.ms, ctx.signal);
        return false;
      case 'diary':
        yield { type: 'diary', category: step.category, text: text(step.text) };
        return false;
      case 'sitrep':
        yield {
          type: 'sitrep',
          text: text(step.text),
          ...(step.status ? { status: step.status } : {}),
        };
        return false;
      case 'write-file':
        return yield* writeInWorkspace(brief, text(step.path), text(step.content));
      case 'commit':
        yield* commit(brief, text(step.message));
        return false;
      case 'use-credential': {
        if (!credentialName) {
          yield {
            type: 'step',
            action: 'use-credential',
            detail: 'No credential issued for this task; skipped.',
            outcome: 'skipped',
          };
          return false;
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
        return false;
      }
      case 'cost':
        yield { type: 'cost', units: step.units };
        return false;
      case 'block':
        yield { type: 'blocked', reason: text(step.reason) };
        return true;
      case 'fail':
        yield { type: 'failed', reason: text(step.reason) };
        return true;
      case 'stand-down':
        yield { type: 'stood-down', reason: text(step.reason) };
        return true;
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
        return false;
      case 'done':
        yield { type: 'done', summary: text(step.summary) };
        return true;
      case 'require-handover': {
        const note = brief.lastHandover ? parseHandoverMarkdown(brief.lastHandover.markdown) : null;
        if (!note || note.nextSteps.length === 0) {
          yield { type: 'blocked', reason: text(step.missing) };
          return true;
        }
        state.handover = note;
        yield {
          type: 'step',
          action: 'read-handover',
          detail: `Read "${brief.lastHandover!.title}" (v${brief.lastHandover!.version}): ${note.nextSteps.length} next step(s).`,
          outcome: 'understood',
        };
        return false;
      }
      case 'require-field-manual': {
        const re = new RegExp(step.pattern);
        let found = brief.fieldManual
          .map((e) => re.exec(`${e.title}\n${e.body}`))
          .find((m): m is RegExpExecArray => !!m);
        let where = 'the Field Manual in the brief';
        if (!found) {
          // Not in the brief: search the unit's record on demand.
          for (const hit of await ctx.searchRecord(step.query)) {
            const m = re.exec(hit.snippet.replace(/[⟦⟧]/g, ''));
            if (m) {
              found = m;
              where = `a record search for "${step.query}"`;
              break;
            }
          }
        }
        if (!found) {
          yield { type: 'blocked', reason: text(step.missing) };
          return true;
        }
        state.vars[step.as] = found[1] ?? found[0];
        yield {
          type: 'step',
          action: 'read-field-manual',
          detail: `Found the unit convention in ${where}: ${found[0]}`,
          outcome: 'understood',
        };
        return false;
      }
      case 'follow-handover': {
        for (const next of state.handover?.nextSteps ?? []) {
          const m = /^Write `?([^`:\s]+)`?(?::\s*(.*))?$/.exec(next);
          if (!m) {
            yield { type: 'step', action: 'note', detail: `Handover step noted: ${next}` };
            continue;
          }
          const stop = yield* writeInWorkspace(
            brief,
            m[1]!,
            text(m[2] ?? `Written by {callsign}.`),
          );
          if (stop) return true;
        }
        return false;
      }
      case 'respect-order': {
        const re = new RegExp(step.pattern, 'i');
        const forbidding = async () =>
          (await ctx.orders()).standingOrders.find((o) => re.test(o)) ?? null;
        let order = await forbidding();
        if (order && step.holdMs > 0) {
          yield {
            type: 'step',
            action: 'hold',
            detail: `Holding: standing order “${order}” forbids going on. Waiting for a frago.`,
          };
          const until = Date.now() + step.holdMs;
          while (order && Date.now() < until && !ctx.signal.aborted) {
            const frago = await ctx.waitForFrago(until - Date.now());
            if (frago)
              yield {
                type: 'step',
                action: 'frago',
                detail: `Frago received: ${frago.text}`,
                outcome: 'rechecking orders',
              };
            order = await forbidding();
          }
        }
        if (order) {
          yield { type: 'blocked', reason: text(step.blocked) };
          return true;
        }
        yield {
          type: 'step',
          action: 'check-orders',
          detail: 'Current standing orders allow going on.',
          outcome: 'ok',
        };
        return false;
      }
      case 'check-branch': {
        const files = (await git(brief.workspace.path, ['ls-files'])).split('\n');
        const re = new RegExp(step.pattern);
        const hit = files.find((f) => re.test(f));
        yield {
          type: 'step',
          action: 'check',
          detail: step.check,
          outcome: hit ? `found ${hit}` : 'missing',
        };
        if (!hit) {
          yield { type: 'send-back', reason: text(step.sendBack) };
          return true;
        }
        return false;
      }
      case 'deploy': {
        const commit = await git(brief.workspace.path, ['rev-parse', 'HEAD']);
        const ref = `deploy/${step.environment}`;
        await git(brief.workspace.path, ['branch', '--force', ref, commit]);
        yield {
          type: 'step',
          action: 'deploy',
          detail: `Deployed ${commit.slice(0, 10)} to ${step.environment}.`,
          outcome: ref,
        };
        yield {
          type: 'artifact',
          kind: 'deployment',
          ref: `${ref}@${commit}`,
          summary: `Deployed to ${step.environment}`,
        };
        return false;
      }
      case 'require-supply': {
        const re = new RegExp(step.pattern, 'i');
        const item = (await ctx.orders()).supply.find((s) => re.test(s.name));
        if (!item) {
          yield { type: 'blocked', reason: text(step.missing) };
          return true;
        }
        yield {
          type: 'step',
          action: 'check-supply',
          detail: `Using ${item.name} (${item.kind}) issued to the unit.`,
          outcome: 'ok',
        };
        return false;
      }
      case 'leak-credential': {
        if (!credentialName) return false;
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
        return false;
      }
      case 'crash-with-credential': {
        if (!credentialName) return false;
        const v = await ctx.withCredential(credentialName, 'crash test', async (x) => x);
        throw new Error(`connection refused for token ${v}`);
      }
    }
  }
}

async function* writeInWorkspace(
  brief: TaskBrief,
  rel: string,
  content: string,
): AsyncGenerator<BotEvent, Stop> {
  const target = resolve(brief.workspace.path, rel);
  if (relative(brief.workspace.path, target).startsWith('..')) {
    yield { type: 'failed', reason: `Refused to write outside the workspace: ${rel}` };
    return true;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content + '\n', 'utf8');
  yield { type: 'step', action: 'write-file', detail: `Wrote ${rel}`, outcome: 'ok' };
  yield { type: 'artifact', kind: 'file', ref: rel, summary: `Edited ${rel}` };
  return false;
}

async function* commit(brief: TaskBrief, message: string): AsyncGenerator<BotEvent, void> {
  await git(brief.workspace.path, ['add', '-A']);
  if (!(await git(brief.workspace.path, ['status', '--porcelain']))) {
    // Picked up again after a pause: this part was committed last time.
    yield { type: 'step', action: 'commit', detail: message, outcome: 'already committed' };
    return;
  }
  await git(brief.workspace.path, ['commit', '--quiet', '-m', message]);
  const sha = await git(brief.workspace.path, ['rev-parse', 'HEAD']);
  yield { type: 'step', action: 'commit', detail: message, outcome: sha };
  yield { type: 'artifact', kind: 'commit', ref: sha, summary: message };
}

async function hasWorkOnBranch(brief: TaskBrief): Promise<boolean> {
  const log = await git(brief.workspace.path, [
    'log',
    '--format=%H',
    `${brief.workspace.baseCommit}..HEAD`,
  ]);
  return log.length > 0;
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
