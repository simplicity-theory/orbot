import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  describeHoldPolicy,
  ChatAction,
  type AfterActionInput,
  type AfterActionReview,
  type DisputeInput,
  type DisputeRuling,
  type BackbriefDraft,
  type BackbriefInput,
  type BotEvent,
  type BotRuntime,
  type ColdStartAssessment,
  type ColdStartInput,
  type CurationAction,
  type CurationInput,
  type InterpretInput,
  type Interpretation,
  type OperationPlan,
  type OperationPlanInput,
  type RulesOfEngagement,
  type RunContext,
  type TaskBrief,
  OperationNeed,
} from '@orbot/shared';
import { git } from '../common/git.js';

const run = promisify(execFile);

/** The unit's rules of engagement, as a bot reads them. */
function roe(r: RulesOfEngagement): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n') || '- none';
  return `May do alone:\n${list(r.mayDoAlone)}\nMust ask permission first:\n${list(r.mustEscalate)}`;
}

/** A bot tool: a name, what it does, and a strict JSON Schema for its input. */
export interface BotTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: str } as const;
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false as const,
});

/** The bot's tools. Each one maps onto ORBOT's record (BotEvents) or the workspace. */
export const TOOLS: BotTool[] = [
  {
    name: 'list_files',
    description: 'List files under a directory of the workspace (relative path, "." for the root).',
    input_schema: obj({ path: str }),
  },
  {
    name: 'read_file',
    description: 'Read a text file in the workspace.',
    input_schema: obj({ path: str }),
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace.',
    input_schema: obj({ path: str, content: str }),
  },
  {
    name: 'run_script',
    description:
      'Run an npm script defined in the workspace package.json (e.g. "test"). Returns its output.',
    input_schema: obj({ script: str }),
  },
  {
    name: 'commit',
    description: 'Commit all workspace changes on the task branch.',
    input_schema: obj({ message: str }),
  },
  {
    name: 'log_diary',
    description:
      'Write to the unit War Diary: a decision you made, a surprise, or a note a successor should see.',
    input_schema: obj({
      category: { type: 'string', enum: ['decision', 'surprise', 'note'] },
      text: str,
    }),
  },
  {
    name: 'sitrep',
    description: 'Send a short progress report up the chain.',
    input_schema: obj({ text: str }),
  },
  {
    name: 'search_record',
    description: 'Search the unit record (current documents first, archive as fallback).',
    input_schema: obj({ query: str }),
  },
  {
    name: 'check_orders',
    description:
      'Re-read the unit standing orders and supply as they stand now (they can change mid-task).',
    input_schema: obj({}),
  },
  {
    name: 'write_handover',
    description:
      'Write the handover for this task. Required before finishing, blocking, failing or standing down.',
    input_schema: obj({
      state: str,
      nextSteps: strArr,
      triedAndFailed: strArr,
      openProblems: strArr,
      flagsForSuccessor: strArr,
    }),
  },
  { name: 'done', description: 'The task is complete.', input_schema: obj({ summary: str }) },
  {
    name: 'blocked',
    description: 'You cannot continue without something from outside the unit.',
    input_schema: obj(
      {
        reason: str,
        action: {
          type: 'string',
          description:
            'What the Commander can do to clear it: what to give, what to decide, or what to order.',
        },
      },
      ['reason'],
    ),
  },
  {
    name: 'failed',
    description: 'The task cannot be completed as specified.',
    input_schema: obj(
      {
        reason: str,
        action: {
          type: 'string',
          description:
            'What the Commander can do about it: what to change in the task or the orders, or what to decide.',
        },
      },
      ['reason'],
    ),
  },
  {
    name: 'send_back',
    description:
      'A check failed: send the work back to the unit that handed it over, with the reason.',
    input_schema: obj({ reason: str }),
  },
  {
    name: 'stand_down',
    description: 'Stop part-way (after a handover) so another bot can pick the task up.',
    input_schema: obj({ reason: str }),
  },
  {
    name: 'file_report',
    description:
      'File a report for your unit (recon findings): what you looked at, what you found, risks and a suggested approach. Markdown.',
    input_schema: obj({ title: str, markdown: str }),
  },
  {
    name: 'list_servers',
    description:
      'List the servers your unit holds (environments you can log in to over SSH): name, tier, user@host, URL, GPU, the user dev_run works as, and the apps running there.',
    input_schema: obj({}),
  },
  {
    name: 'server_run',
    description:
      'Run a shell command on one of your unit’s servers over SSH, as its configured user (non-interactive: no prompts, no TTY; use `sudo -n` where needed). Returns the exit code and output. Production servers, and servers that run apps, only inside an approved deploy task.',
    input_schema: obj({ server: str, command: str }),
  },
  {
    name: 'server_upload',
    description:
      'Copy your committed work (HEAD of your branch, as git archive) into a directory on one of your unit’s servers, creating it if needed. Commit first. Recorded as a deployment to that server.',
    input_schema: obj({ server: str, path: str }),
  },
  {
    name: 'list_sites',
    description:
      'List the static sites your unit holds: environments with no server, which ORBOT publishes itself. Name, tier, URL, the file served at the root, and the commit published last.',
    input_schema: obj({}),
  },
  {
    name: 'publish',
    description:
      'Publish files from your committed work (HEAD of your branch) to one of your unit’s static sites: paths relative to the repository (leave empty for the project’s entry file). The site’s entry file (index.html) must be among them. Commit first. Recorded as a deployment; production sites only inside an approved deploy task.',
    input_schema: obj({ site: str, paths: strArr }),
  },
  {
    name: 'dev_run',
    description:
      'Build, test or run anything on your unit’s dev server: your folder there is first brought up to date with your working tree (uncommitted edits included; .git and gitignored paths such as node_modules are left as they are), then the shell command runs in that folder. Install what you need (non-interactive; `sudo -n` if allowed). Leave server empty for the unit’s dev server.',
    input_schema: obj({ server: str, command: str }),
  },
  {
    name: 'dev_fetch',
    description:
      'Copy a file or directory from your folder on the dev server back into your workspace (e.g. an updated lockfile or generated code), path relative to the folder. Leave server empty for the unit’s dev server.',
    input_schema: obj({ server: str, path: str }),
  },
  {
    name: 'raise_dispute',
    description:
      'You disagree with another unit (name it) about this work, e.g. its rules conflict with your brief. HQ rules under standing orders; you then follow the ruling.',
    input_schema: obj({ against: str, claim: str }),
  },
  {
    name: 'request_permission',
    description:
      'Ask permission before doing something your unit’s rules of engagement say you must escalate. Name the action, quote the rule, and say why. Write a handover first: the task waits for the decision, then you pick it up again with the decision in your brief.',
    input_schema: obj({ action: str, rule: str, reason: str }),
  },
];

/** What the shape of the product means for the bot's work, when the repository was templated. */
export function projectRules(brief: Pick<TaskBrief, 'repository' | 'task'>): string {
  const p = brief.repository?.project;
  if (!p) return '';
  if (p.kind === 'single-html') {
    return [
      `${brief.repository!.name} is a single-file web app: the whole product is ${p.entry}, one self-contained HTML file. No build step, no package manager, no server, and nothing fetched from any other origin at runtime: markup, styles and scripts stay inline in that file, and it must work opened straight from disk. Anything it remembers lives in the browser (localStorage, or files the user saves). Keep it accessible and usable on a phone.`,
      `Test it with run_script (for example a Node script that parses ${p.entry} or checks what it must contain); a test page, if you add one, loads nothing but ${p.entry}'s code.`,
      brief.task.kind === 'deploy'
        ? `Deploying it means publishing ${p.entry} as it is: use list_sites to find the unit's site, then publish with no paths (the entry file).`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** Recon is read-only: no tool that changes the workspace. */
const WRITE_TOOLS = new Set([
  'write_file',
  'run_script',
  'commit',
  'send_back',
  'server_run',
  'server_upload',
  'dev_fetch',
  'publish',
]);
export const RECON_TOOLS = TOOLS.filter((t) => !WRITE_TOOLS.has(t.name));

export const TERMINAL = new Set([
  'done',
  'blocked',
  'failed',
  'send_back',
  'stand_down',
  'raise_dispute',
  'request_permission',
]);

/**
 * What every Claude runtime shares: the bot's tools (each mapped onto ORBOT's record or
 * the workspace), its prompts, and the Overseer/HQ work done with structured outputs.
 * Subclasses supply the transport: the Anthropic API, or Claude Code.
 */
export abstract class ClaudeFamilyRuntime implements BotRuntime {
  abstract readonly kind: string;

  abstract run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent>;

  /** One structured answer from the model, validated against the schema. */
  protected abstract structured<S extends z.ZodType>(
    schema: S,
    system: string,
    prompt: string,
  ): Promise<z.infer<S>>;

  /** The event a terminal tool call ends the run with. */
  protected finish(name: string, input: Record<string, unknown>): BotEvent {
    const s = (k: string) => String(input[k] ?? '');
    if (name === 'raise_dispute')
      return { type: 'dispute', against: s('against'), claim: s('claim') };
    if (name === 'request_permission')
      return { type: 'permission', action: s('action'), rule: s('rule'), reason: s('reason') };
    const action = typeof input['action'] === 'string' && input['action'] ? input['action'] : null;
    return this.terminal(name, String(input['reason'] ?? input['summary'] ?? ''), action);
  }

  protected terminal(name: string, text: string, action: string | null = null): BotEvent {
    const next = action ? { action } : {};
    switch (name) {
      case 'done':
        return { type: 'done', summary: text };
      case 'blocked':
        return { type: 'blocked', reason: text, ...next };
      case 'send_back':
        return { type: 'send-back', reason: text };
      case 'stand_down':
        return { type: 'stood-down', reason: text };
      default:
        return { type: 'failed', reason: text, ...next };
    }
  }

  private safe(brief: TaskBrief, path: string): string {
    const target = resolve(brief.workspace.path, path);
    const rel = relative(brief.workspace.path, target);
    if (rel.startsWith('..') || rel.includes('.git'))
      throw new Error(`Outside the workspace: ${path}`);
    return target;
  }

  protected async tool(
    name: string,
    input: Record<string, unknown>,
    brief: TaskBrief,
    ctx: RunContext,
  ): Promise<{ events: BotEvent[]; output: string }> {
    const s = (k: string) => String(input[k] ?? '');
    if (brief.task.kind === 'recon' && WRITE_TOOLS.has(name))
      throw new Error('Recon is read-only: this task may not change the workspace.');
    switch (name) {
      case 'file_report':
        return {
          events: [{ type: 'report', title: s('title'), markdown: s('markdown') }],
          output: 'Report filed with your unit.',
        };
      case 'list_servers': {
        const list = await ctx.servers();
        return {
          events: [],
          output: list.length
            ? list
                .map((x) =>
                  [
                    `- ${x.name} (${x.tier}): ${x.user}@${x.host}${x.url ? `, ${x.url}` : ''}`,
                    x.gpu ? `  GPU: ${x.gpu}` : null,
                    x.tier === 'dev' ? `  dev_run works as ${x.devUser}` : null,
                    x.apps.length
                      ? `  Runs apps (${x.apps.join(', ')}): server_run and server_upload only inside an approved deploy; do not stop or change them`
                      : null,
                  ]
                    .filter(Boolean)
                    .join('\n'),
                )
                .join('\n')
            : 'Your unit holds no servers.',
        };
      }
      case 'dev_run':
      case 'dev_fetch': {
        const server = s('server').trim() || null;
        const r =
          name === 'dev_run'
            ? await ctx.devRun(server, s('command'))
            : await ctx.devFetch(server, s('path'));
        return {
          events:
            name === 'dev_fetch' && r.exitCode === 0
              ? [
                  {
                    type: 'artifact',
                    kind: 'file',
                    ref: s('path'),
                    summary: `Copied ${s('path')} back from the dev server`,
                  },
                ]
              : [],
          output: `exit ${r.exitCode ?? 'none (stopped)'}\n${r.output}`,
        };
      }
      case 'list_sites': {
        const list = await ctx.sites();
        return {
          events: [],
          output: list.length
            ? list
                .map(
                  (x) =>
                    `- ${x.name} (${x.tier}): ${x.url}, serves ${x.entry} at its root${x.lastCommit ? `, last published ${x.lastCommit.slice(0, 10)}` : ', nothing published yet'}`,
                )
                .join('\n')
            : 'Your unit holds no static sites.',
        };
      }
      case 'publish': {
        // The sites service puts the deployment on the record.
        const r = await ctx.publish(s('site'), (input['paths'] as string[]) ?? []);
        return { events: [], output: `exit ${r.exitCode ?? 'none'}\n${r.output}` };
      }
      case 'server_run':
      case 'server_upload': {
        // The servers service puts the command and its redacted output on the record.
        const r =
          name === 'server_run'
            ? await ctx.serverRun(s('server'), s('command'))
            : await ctx.serverUpload(s('server'), s('path'));
        return {
          events: [],
          output: `exit ${r.exitCode ?? 'none (stopped)'}\n${r.output}`,
        };
      }
      case 'list_files': {
        const dir = this.safe(brief, s('path') || '.');
        const entries = await readdir(dir, { withFileTypes: true });
        const out = entries
          .filter((e) => e.name !== '.git')
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join('\n');
        return {
          events: [{ type: 'step', action: 'list-files', detail: `Listed ${s('path') || '.'}` }],
          output: out || '(empty)',
        };
      }
      case 'read_file': {
        const content = await readFile(this.safe(brief, s('path')), 'utf8');
        return {
          events: [{ type: 'step', action: 'read-file', detail: `Read ${s('path')}` }],
          output: content.slice(0, 100_000),
        };
      }
      case 'write_file': {
        const target = this.safe(brief, s('path'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, s('content'), 'utf8');
        return {
          events: [
            { type: 'step', action: 'write-file', detail: `Wrote ${s('path')}`, outcome: 'ok' },
            { type: 'artifact', kind: 'file', ref: s('path'), summary: `Edited ${s('path')}` },
          ],
          output: 'Written.',
        };
      }
      case 'run_script': {
        const script = s('script');
        if (!/^[a-z0-9:_-]+$/i.test(script))
          throw new Error('Script names are letters, digits, colons, dashes and underscores.');
        let output: string;
        let outcome = 'passed';
        try {
          const r = await run('npm', ['run', '--silent', script], {
            cwd: brief.workspace.path,
            timeout: 300_000,
            maxBuffer: 8 * 1024 * 1024,
            signal: ctx.signal,
          });
          output = `${r.stdout}${r.stderr}`;
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message: string };
          output = `${e.stdout ?? ''}${e.stderr ?? e.message}`;
          outcome = 'failed';
        }
        return {
          events: [{ type: 'step', action: 'run-script', detail: `npm run ${script}`, outcome }],
          output: output.slice(-20_000) || outcome,
        };
      }
      case 'commit': {
        await git(brief.workspace.path, ['add', '-A']);
        await git(brief.workspace.path, ['commit', '--quiet', '-m', s('message')]);
        const sha = await git(brief.workspace.path, ['rev-parse', 'HEAD']);
        return {
          events: [
            { type: 'step', action: 'commit', detail: s('message'), outcome: sha },
            { type: 'artifact', kind: 'commit', ref: sha, summary: s('message') },
          ],
          output: `Committed ${sha}.`,
        };
      }
      case 'log_diary': {
        const category =
          (['decision', 'surprise', 'note'] as const).find((c) => c === s('category')) ?? 'note';
        return { events: [{ type: 'diary', category, text: s('text') }], output: 'Logged.' };
      }
      case 'sitrep':
        return { events: [{ type: 'sitrep', text: s('text') }], output: 'Sent.' };
      case 'search_record': {
        const hits = await ctx.searchRecord(s('query'));
        return {
          events: [
            {
              type: 'step',
              action: 'search-record',
              detail: `Searched the record for “${s('query')}”`,
              outcome: `${hits.length} hit(s)`,
            },
          ],
          output: hits.length
            ? hits
                .map((h) => `${h.archived ? '[archived] ' : ''}${h.title}: ${h.snippet}`)
                .join('\n')
            : 'No matches.',
        };
      }
      case 'check_orders': {
        const o = await ctx.orders();
        return {
          events: [
            { type: 'step', action: 'check-orders', detail: 'Re-read standing orders and supply' },
          ],
          output: `Standing orders:\n${o.standingOrders.map((x) => `- ${x}`).join('\n') || '- none'}\n${roe(o.rulesOfEngagement)}\nSupply:\n${o.supply.map((x) => `- ${x.name} (${x.kind})`).join('\n') || '- none'}`,
        };
      }
      case 'write_handover':
        return {
          events: [
            {
              type: 'handover',
              note: {
                state: s('state'),
                nextSteps: (input['nextSteps'] as string[]) ?? [],
                triedAndFailed: (input['triedAndFailed'] as string[]) ?? [],
                openProblems: (input['openProblems'] as string[]) ?? [],
                flagsForSuccessor: (input['flagsForSuccessor'] as string[]) ?? [],
              },
            },
          ],
          output: 'Handover written.',
        };
      default:
        throw new Error(`Unknown tool ${name}.`);
    }
  }

  protected systemPrompt(brief: TaskBrief): string {
    return [
      `You are ${brief.bot.callsign}, a ${brief.bot.role} in the ${brief.unit.name} unit of ORBOT, working one task in your own git worktree on branch ${brief.workspace.branch}.`,
      'You arrived today: everything you know about this work comes from the brief below (the unit’s documents). Act on it, and leave the unit better documented than you found it.',
      'Work only through your tools; you cannot reach anything outside the workspace. Record decisions and surprises in the War Diary as you go, send a sitrep at milestones, commit your changes, and always write a handover before you finish, block, fail, send back or stand down.',
      'If a check you are running fails because of the previous unit’s work, use send_back with a reason they can act on. If you need something only someone outside the unit can give (access, a decision), use blocked, and say in action what the Commander can do to clear it (what to give, decide or order); the same in action when you use failed. If another unit’s rules conflict with your brief, use raise_dispute; once ruled on, follow the ruling. If your unit’s rules of engagement say something must be escalated, use request_permission before doing it.',
      'If your unit holds a dev server (list_servers shows tier dev), build, test and iterate there with dev_run: edit code in your workspace with write_file, then dev_run syncs it and runs the command in your own folder on the server. Use dev_fetch for files the server generates that belong in the repository. Commit as usual: the workspace is the work of record, not the dev server.',
      'If your unit holds servers (list_servers), you may log in to them with server_run and set them up as the task needs; copy committed work there with server_upload. Leave each server documented: what you installed, where, how to restart it, in the War Diary and your handover, so a successor can carry on.',
      projectRules(brief),
      brief.workspace.restarted
        ? `Your branch was restarted from the integrated work: merging it into your earlier commits conflicted (${brief.workspace.restarted.conflicts.join(', ') || 'in the tree'}). Those commits are kept on branch ${brief.workspace.restarted.kept} (see them with run_script: git log ${brief.workspace.restarted.kept}, git show <commit>); bring over what still matters and carry on from the integrated work. Nothing is lost.`
        : '',
      `Hold policy (what comes to the Commander): ${describeHoldPolicy(brief.unit.holdPolicy)} Judge each finding's severity (low, medium, high, critical) and how big its fix would be (small: a few lines inside the work under review; medium: changes across it; large: beyond it, a rewrite). Fix it yourself only within the policy and commit the fix; otherwise record it in the War Diary and your handover; use blocked, naming the finding, only when the policy holds the work on it. The same goes for any problem you run into.`,
      brief.task.kind === 'check'
        ? 'This is a check task on work another unit handed over. Run the checks your orders and Field Manual name. Record every finding with its severity and what you did about it. A check the previous unit must redo: send_back with what to fix.'
        : '',
      brief.task.kind === 'recon'
        ? 'This is a recon task: read-only. Survey the code to answer the question, change nothing, and file_report your findings (what you looked at, what you found, risks, a suggested approach) before the handover and done.'
        : '',
      brief.unit.standingOrders.length
        ? `Standing orders (always apply):\n${brief.unit.standingOrders.map((o) => `- ${o}`).join('\n')}`
        : '',
      brief.unit.rulesOfEngagement.mustEscalate.length
        ? `Rules of engagement:\n${roe(brief.unit.rulesOfEngagement)}\nBefore you do anything under "Must ask permission first", use request_permission (after a handover) and wait for the decision. Never do it on your own judgement. A refused action stays refused: find another way, or report blocked with what you would need.`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  protected taskPrompt(brief: TaskBrief): string {
    return [
      `# Task #${brief.task.number}: ${brief.task.title}`,
      brief.task.description,
      brief.permissions.length
        ? `## Decisions on what you asked permission for (follow them)\n${brief.permissions.map((p) => `- ${p.approved ? 'Approved' : 'Refused'}: ${p.action}${p.note ? ` (${p.note})` : ''}`).join('\n')}`
        : '',
      brief.rulings.length
        ? `## Rulings on your disputes (follow them)\n${brief.rulings.map((r) => `- ${r.text}`).join('\n')}`
        : '',
      brief.lastHandover
        ? `## Last handover for this work (v${brief.lastHandover.version})\n${brief.lastHandover.markdown}`
        : '## Last handover\nNone: nobody has worked this before.',
      brief.fieldManual.length
        ? `## Field Manual\n${brief.fieldManual.map((e) => `### ${e.title}\n${e.body}`).join('\n\n')}`
        : '',
      brief.recon?.length
        ? `## Recon reports\n${brief.recon.map((r) => `### ${r.title}\n${r.markdown}`).join('\n\n')}`
        : '',
      brief.recentDiary.length
        ? `## Recent War Diary\n${brief.recentDiary.map((d) => `- ${d.category}: ${d.text}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  // ---------- Overseer and HQ work: structured outputs ----------

  async draftBackbrief(input: BackbriefInput): Promise<BackbriefDraft> {
    const Draft = z.object({
      summary: z.string(),
      risks: z.array(z.string()),
      proposedTasks: z.array(
        z.object({
          title: z.string(),
          description: z.string(),
          botId: z.string().nullable(),
          kind: z.enum(['work', 'fix', 'check', 'deploy']),
          repoSupplyId: z.string().nullable(),
        }),
      ),
    });
    const d = await this.structured(
      Draft,
      `You are the Overseer of the ${input.unit.name} unit. Plan how your bots will carry out a mission, and brief the plan back to the Commander.`,
      JSON.stringify({
        ...input,
        instructions:
          'Split the mission into tasks (one per definition-of-done item unless a better split is obvious), assign each to the least busy suitable bot by id, and list real risks. For stage "inspect"/"guard" use one "check" task; for stage "deploy" one "deploy" task. If there is more than one repository, set repoSupplyId to the id of the one each task changes (null = the first). A repository whose project is "single-html" holds one self-contained HTML file (its entry) and nothing else: no build, no server; plan tasks that keep it that way, and a deploy that publishes the entry file to the unit’s static site.',
      }),
    );
    const repos = new Set(input.repositories.map((r) => r.id));
    return {
      ...d,
      proposedTasks: d.proposedTasks.map((t) => ({
        ...t,
        scenario: null,
        repoSupplyId: t.repoSupplyId && repos.has(t.repoSupplyId) ? t.repoSupplyId : null,
      })),
    };
  }

  async curate(input: CurationInput): Promise<CurationAction[]> {
    const Actions = z.object({
      actions: z.array(
        z.object({
          kind: z.enum(['promote', 'merge', 'retire']),
          entryId: z.string().nullable(),
          title: z.string().nullable(),
          body: z.string().nullable(),
          reason: z.string(),
        }),
      ),
    });
    const r = await this.structured(
      Actions,
      `You are the Overseer of the ${input.unit.name} unit, curating its Field Manual: the lasting knowledge every new bot is briefed from.`,
      JSON.stringify({
        ...input,
        instructions:
          'From this handover, promote only lessons that will matter beyond this task; merge into an existing entry (by entryId) when it is the same lesson; retire entries the handover shows are outdated. Return no actions if nothing lasting was learned.',
      }),
    );
    return r.actions.flatMap((a): CurationAction[] => {
      if (a.kind === 'promote' && a.title && a.body)
        return [
          { kind: 'promote', title: a.title, body: a.body, tags: ['lesson'], reason: a.reason },
        ];
      if (a.kind === 'merge' && a.entryId)
        return [{ kind: 'merge', entryId: a.entryId, body: a.body, reason: a.reason }];
      if (a.kind === 'retire' && a.entryId)
        return [{ kind: 'retire', entryId: a.entryId, reason: a.reason }];
      return [];
    });
  }

  async assessColdStart(input: ColdStartInput): Promise<ColdStartAssessment> {
    const A = z.object({
      score: z.number().int().min(0).max(100),
      gaps: z.array(
        z.object({
          description: z.string(),
          suggestedEntry: z.object({ title: z.string(), body: z.string() }).nullable(),
        }),
      ),
    });
    return this.structured(
      A,
      `You are the Overseer of the ${input.unit.name} unit, running a cold-start check.`,
      JSON.stringify({
        ...input,
        instructions:
          'Imagine a capable bot that knows nothing but these documents. Could it continue the task? Score 0-100 and list concrete gaps; where a Field Manual entry would close a gap, write it.',
      }),
    );
  }

  async interpret(input: InterpretInput): Promise<Interpretation> {
    const I = z.object({
      kinds: z.array(
        z.enum(['question', 'order', 'frago', 'rule-change', 'supply-grant', 'musing']),
      ),
      answer: z.string().nullable(),
      actions: z.array(ChatAction),
      musings: z.array(ChatAction),
      missing: z.array(
        z.object({
          what: z.string(),
          kind: z.enum(['repository', 'credential', 'environment', 'supply']),
        }),
      ),
      unclear: z.array(z.string()),
    });
    return this.structured(
      I,
      'You are an Overseer (or HQ) in ORBOT. The Commander commands by chat. Turn the message into typed actions; answer questions from the context. `history` holds the channel’s recent turns: a short reply such as "Do it", "Yes" or "the first one" refers to what you last proposed there, so act on that proposal. When your answer suggests doing something, put it in musings as typed actions (the Commander confirms with a word) instead of only describing it in prose. Hedged statements ("I might…", "maybe") are musings, not orders. Only reference ids that appear in the context. If promised supply is not in the depot, list it as missing instead of acting. Operations get resources from the depot: assign-resource gives one to an operation (create-operation may also list supplyIds to start with, repositories first); release-resource takes one off. The first repository is the main one, where work lands: to change an operation’s repository ("change the repo from A to B") use set-main-repository with B (it is assigned if it is not yet; once missions are out they are issued again there), never only assign-resource. cancel-operation calls an operation off (note: why, if given). new-project starts a project ("start a new project called X: …"): a repository from a template (projectKind single-html: one self-contained HTML file, no server) and a static site ORBOT publishes it to; with an intent, the operation that builds it.',
      JSON.stringify(input),
    );
  }

  async planOperation(input: OperationPlanInput): Promise<OperationPlan> {
    const P = z.object({
      name: z.string(),
      missions: z.array(
        z.object({
          unitId: z.string(),
          stage: z.enum(['build', 'inspect', 'guard', 'deploy']),
          goal: z.string(),
          definitionOfDone: z.array(z.string()),
        }),
      ),
      needs: z.array(OperationNeed),
    });
    return this.structured(
      P,
      'You are HQ in ORBOT, holding the O Group for an operation.',
      JSON.stringify({
        ...input,
        instructions:
          'Give each unit one mission, in handoff order build → inspect → guard → deploy, matched to the unit roles. Use only the unit ids given. In needs, list what else the operation must have from the Supply Depot to succeed, beyond a repository and (for a deploy) a production environment, which are always added: e.g. a dev server with a GPU, a model, a staging environment, a credential for an outside service. Mark nice-to-haves optional. List nothing it does not need; resources already assigned are given. A resource whose project is "single-html" is a repository holding one self-contained HTML file: the product is that file alone (no build, no server), and its deploy publishes the file to a static site, which the operation’s site resource is.',
      }),
    );
  }

  async ruleDispute(input: DisputeInput): Promise<DisputeRuling> {
    const R = z.object({
      prevails: z.enum(['raiser', 'other']).nullable(),
      reasoning: z.string(),
      cited: z.array(
        z.object({
          unitId: z.string().nullable(),
          orderId: z.string().nullable(),
          text: z.string(),
        }),
      ),
    });
    return this.structured(
      R,
      'You are HQ in ORBOT, ruling on a dispute between two units under their standing orders.',
      JSON.stringify({
        ...input,
        instructions:
          'Rule only on the standing orders given: cite the order(s) that settle it (copy their text, unit id and order id). If no standing order settles it, set prevails to null so it goes to the Commander. Do not invent orders.',
      }),
    );
  }

  async afterAction(input: AfterActionInput): Promise<AfterActionReview> {
    const R = z.object({
      summary: z.string(),
      wentWell: z.array(z.string()),
      toImprove: z.array(z.string()),
      lessons: z.array(z.object({ unitId: z.string().nullable(), text: z.string() })),
    });
    return this.structured(
      R,
      'You are HQ in ORBOT, holding the After Action review of an operation.',
      JSON.stringify({
        ...input,
        instructions:
          'Be specific and brief. Lessons become standing orders for the named unit (or all units if unitId is null), so phrase each as a rule.',
      }),
    );
  }
}
