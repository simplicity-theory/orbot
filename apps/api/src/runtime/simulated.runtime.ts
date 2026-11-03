import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
/** True: the run ends here. A number: skip that many of the following steps. */
type Stop = boolean | number;

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

    for (let i = 0; i < script.length; i++) {
      if (ctx.signal.aborted) return;
      const stop = yield* this.perform(script[i]!, brief, ctx, text, state);
      if (stop === true) return;
      if (typeof stop === 'number') i += stop;
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
      case 'ask-permission': {
        const action = text(step.action);
        const decision = brief.permissions.findLast((p) => p.action === action);
        if (decision) {
          // Decided: go ahead, or leave the refused work out and carry on.
          yield {
            type: 'step',
            action: 'read-decision',
            detail: `${decision.approved ? 'Approved' : 'Refused'}: ${action}${decision.note ? ` (${decision.note})` : ''}`,
            outcome: decision.approved ? 'going ahead' : 'will not do it',
          };
          return decision.approved ? false : step.skipIfRefused;
        }
        yield { type: 'permission', action, rule: text(step.rule), reason: text(step.reason) };
        return true;
      }
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
      case 'survey': {
        const report = await survey(brief);
        yield {
          type: 'step',
          action: 'survey',
          detail: `Surveyed ${report.files} tracked file(s) for “${report.question}”.`,
          outcome: report.hits.length ? `${report.hits.length} relevant` : 'nothing relevant',
        };
        yield { type: 'report', title: `Recon: ${report.question}`, markdown: report.markdown };
        return false;
      }
      case 'deploy': {
        const commit = await git(brief.workspace.path, ['rev-parse', 'HEAD']);
        // A static site the unit holds, by name or by tier ("production"): ORBOT publishes it.
        const sites = await ctx.sites();
        const site =
          sites.find((s) => s.name.toLowerCase() === step.environment.toLowerCase()) ??
          sites.find((s) => s.tier === step.environment);
        if (site) {
          const r = await ctx.publish(site.name, []);
          yield {
            type: 'step',
            action: 'deploy',
            detail: r.output,
            outcome: r.exitCode === 0 ? 'published' : `exit ${r.exitCode}`,
          };
          if (r.exitCode !== 0) {
            yield { type: 'failed', reason: r.output };
            return true;
          }
          return false;
        }
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
        const re = step.pattern ? new RegExp(step.pattern, 'i') : null;
        const item = (await ctx.orders()).supply.find(
          (s) => (!re || re.test(s.name)) && (!step.tier || s.tier === step.tier),
        );
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

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'how',
  'what',
  'where',
  'does',
  'with',
  'our',
  'are',
  'any',
  'this',
  'that',
  'into',
  'from',
  'which',
  'when',
  'why',
  'who',
  'is',
  'do',
  'we',
  'it',
  'of',
  'to',
  'in',
  'on',
  'a',
  'an',
]);

/** Read-only survey of the workspace for a recon question: which tracked files bear on it. */
async function survey(brief: TaskBrief) {
  const question = (brief.task.description || brief.task.title).trim().replace(/[?.!\s]+$/, '');
  const terms = [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  ];
  const files = (await git(brief.workspace.path, ['ls-files']))
    .split('\n')
    .filter((f) => f && !f.startsWith('orbot/'));
  const hits: { file: string; terms: string[]; line: string | null }[] = [];
  for (const file of files) {
    let text = '';
    try {
      text = await readFile(resolve(brief.workspace.path, file), 'utf8');
    } catch {
      continue;
    }
    if (text.length > 200_000) text = text.slice(0, 200_000);
    const lower = `${file.toLowerCase()}\n${text.toLowerCase()}`;
    const found = terms.filter((t) => lower.includes(t));
    if (!found.length) continue;
    const line =
      text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && found.some((t) => l.toLowerCase().includes(t))) ?? null;
    hits.push({ file, terms: found, line });
  }
  hits.sort((a, b) => b.terms.length - a.terms.length || a.file.localeCompare(b.file));
  const top = hits.slice(0, 10);
  const markdown = [
    `# Recon: ${question}`,
    '',
    `Surveyed by ${brief.bot.callsign} (${brief.unit.name}) on \`${brief.workspace.branch}\`. Read-only: nothing was changed.`,
    '',
    '## What I found',
    top.length
      ? top
          .map(
            (h) =>
              `- \`${h.file}\` — mentions ${h.terms.join(', ')}${h.line ? `: “${h.line.slice(0, 120)}”` : ''}`,
          )
          .join('\n')
      : '- Nothing in the tracked files bears on this.',
    '',
    '## Suggested approach',
    top.length
      ? `Start from \`${top[0]!.file}\`; ${top.length > 1 ? `check ${top.length - 1} related file(s) above before changing it.` : 'it is the only file that bears on this.'}`
      : 'This is new ground: plan it from scratch, and say so in the backbrief.',
    '',
    '## Risks',
    hits.length > 10
      ? `- Wide footprint: ${hits.length} files mention it. Expect overlaps with other work.`
      : '- None seen from the survey.',
    '',
  ].join('\n');
  return { question, files: files.length, hits, markdown };
}
