import {
  createSdkMcpServer,
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BotEvent, RunContext, TaskBrief } from '@orbot/shared';
import {
  ClaudeFamilyRuntime,
  RECON_TOOLS,
  TERMINAL,
  TOOLS,
  type BotTool,
} from './claude-common.js';

/** The parts of the Agent SDK ClaudeCodeRuntime uses (tests inject a fake). */
export interface ClaudeCodeSdk {
  query: (params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
  }) => AsyncIterable<SDKMessage>;
  createSdkMcpServer: typeof createSdkMcpServer;
}

export interface ClaudeCodeRuntimeOptions {
  model: string;
  /** Model turns before the bot is stopped as failed. */
  maxTurns?: number;
  /** Output tokens per compute unit, for the budget record. */
  tokensPerUnit?: number;
  /** A `claude` binary to use instead of the one bundled with the SDK. */
  executable?: string;
  /** The environment the Claude Code process would inherit (default: this process's). */
  env?: NodeJS.ProcessEnv;
}

const SERVER = 'orbot';

/**
 * What the Claude Code process may see of ORBOT's environment: enough to run and to find
 * the Commander's own login, nothing else. ORBOT's keys and passwords stay behind, and so
 * does ANTHROPIC_API_KEY: if it were passed, Claude Code would bill the API instead of
 * the Claude plan.
 */
const PASS_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
];

export function claudeCodeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: 'orbot/0.1' };
  for (const k of PASS_ENV) if (env[k]) out[k] = env[k];
  return out;
}

/** A bot tool's strict JSON Schema as the zod shape an SDK MCP tool takes. */
function shapeOf(tool: BotTool): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(tool.input_schema.properties)) {
    const p = v as { type: string; enum?: string[] };
    shape[k] =
      p.type === 'array'
        ? z.array(z.string())
        : p.enum
          ? z.enum(p.enum as [string, ...string[]])
          : z.string();
  }
  return shape;
}

/** A queue the run loop reads from while the SDK calls the tool handlers. */
class Inbox<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(item: T): void {
    this.items.push(item);
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length) yield this.items.shift()!;
      else if (this.closed) return;
      else await new Promise<void>((r) => (this.wake = r));
    }
  }
}

const userMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

/** Assistant errors the Commander, not the bot, has to resolve. */
const ACCOUNT_ERRORS: Record<string, string> = {
  authentication_failed:
    'Claude Code is not signed in. Run `claude` once on the ORBOT machine and log in with your Claude plan, then resume the task.',
  oauth_org_not_allowed:
    'Your Claude login is not allowed to use Claude Code here. Check your plan, then resume the task.',
  account_on_hold: 'Your Claude account is on hold. Resolve it at claude.ai, then resume the task.',
  billing_error:
    'Your Claude plan reported a billing problem. Resolve it at claude.ai, then resume.',
  rate_limit:
    'Your Claude plan’s usage limit was reached. Resume the task when it resets, or switch the bot to another runtime.',
};

/**
 * Runs a real bot with Claude Code, signed in with the Commander's own Claude plan (no API
 * key). Same tools, prompts and record as ClaudeRuntime: the bot gets only ORBOT's tools
 * (served in-process over MCP), none of Claude Code's built-in ones, and no settings,
 * hooks or CLAUDE.md from the machine. Meant for one Commander using their own plan.
 */
export class ClaudeCodeRuntime extends ClaudeFamilyRuntime {
  readonly kind = 'claude-code';
  private readonly maxTurns: number;
  private readonly tokensPerUnit: number;
  private readonly env: Record<string, string>;

  constructor(
    private readonly opts: ClaudeCodeRuntimeOptions,
    private readonly sdk: ClaudeCodeSdk = { query, createSdkMcpServer },
  ) {
    super();
    this.maxTurns = opts.maxTurns ?? 40;
    this.tokensPerUnit = opts.tokensPerUnit ?? 10_000;
    this.env = claudeCodeEnv(opts.env ?? process.env);
  }

  private base(): Options {
    return {
      model: this.opts.model,
      env: this.env,
      settingSources: [],
      tools: [],
      persistSession: false,
      permissionMode: 'dontAsk',
      ...(this.opts.executable ? { pathToClaudeCodeExecutable: this.opts.executable } : {}),
    };
  }

  // ---------- Bot work ----------

  async *run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent> {
    const events: BotEvent[] = [];
    let wroteHandover = false;
    let finished: BotEvent | null = null;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    ctx.signal.addEventListener('abort', onAbort);

    const tools = (brief.task.kind === 'recon' ? RECON_TOOLS : TOOLS).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: shapeOf(t),
      handler: async (input: Record<string, unknown>) => {
        const text = (s: string, isError = false) => ({
          content: [{ type: 'text' as const, text: s }],
          isError,
        });
        if (finished) return text('The task is already finished.', true);
        if (TERMINAL.has(t.name)) {
          if (!wroteHandover) return text('Write the handover first (write_handover).', true);
          finished =
            t.name === 'raise_dispute'
              ? {
                  type: 'dispute',
                  against: String(input['against']),
                  claim: String(input['claim']),
                }
              : this.terminal(t.name, String(input['reason'] ?? input['summary'] ?? ''));
          return text('Recorded. Stop here.');
        }
        try {
          const r = await this.tool(t.name, input, brief, ctx);
          if (t.name === 'write_handover') wroteHandover = true;
          events.push(...r.events);
          return text(r.output);
        } catch (err) {
          return text((err as Error).message, true);
        }
      },
    }));

    const inbox = new Inbox<SDKUserMessage>();
    inbox.push(userMessage(this.taskPrompt(brief)));
    const q = this.sdk.query({
      prompt: inbox,
      options: {
        ...this.base(),
        cwd: brief.workspace.path,
        systemPrompt: this.systemPrompt(brief),
        mcpServers: { [SERVER]: this.sdk.createSdkMcpServer({ name: SERVER, tools }) },
        allowedTools: tools.map((t) => `mcp__${SERVER}__${t.name}`),
        maxTurns: this.maxTurns,
        abortController: abort,
      },
    });

    const counted = new Set<string>();
    let nudges = 0;
    let outcome: BotEvent | null = null;
    try {
      for await (const m of q) {
        if (m.type === 'assistant') {
          if (m.error && ACCOUNT_ERRORS[m.error]) {
            outcome = { type: 'blocked', reason: ACCOUNT_ERRORS[m.error]! };
          }
          // One API message can arrive as several SDK messages; count its tokens once.
          const id = m.message.id;
          if (m.parent_tool_use_id === null && id && !counted.has(id)) {
            counted.add(id);
            const out = m.message.usage?.output_tokens ?? 0;
            yield { type: 'cost', units: Math.max(1, Math.round(out / this.tokensPerUnit)) };
          }
        }
        while (events.length) yield events.shift()!;
        if (finished || outcome) break;
        if (m.type === 'result') {
          if (m.subtype === 'error_max_turns') {
            outcome = {
              type: 'failed',
              reason: `Stopped after ${this.maxTurns} turns without finishing.`,
            };
            break;
          }
          if (m.subtype !== 'success') {
            outcome = {
              type: 'failed',
              reason: `Claude Code stopped: ${m.errors.join(' ') || m.subtype}.`,
            };
            break;
          }
          if (++nudges > 3) {
            outcome = { type: 'failed', reason: 'The bot stopped without finishing the task.' };
            break;
          }
          inbox.push(
            userMessage(
              'Use the tools to continue. Finish with write_handover and then done, blocked, failed, send_back or stand_down.',
            ),
          );
        }
      }
    } catch (err) {
      if (!finished && !ctx.signal.aborted) {
        outcome = { type: 'failed', reason: `Claude Code stopped: ${(err as Error).message}` };
      }
    } finally {
      inbox.close();
      ctx.signal.removeEventListener('abort', onAbort);
      if (!abort.signal.aborted) abort.abort();
    }
    while (events.length) yield events.shift()!;
    if (ctx.signal.aborted) return;
    yield finished ?? outcome ?? { type: 'failed', reason: 'The bot stopped without finishing.' };
  }

  // ---------- Overseer and HQ work: structured outputs ----------

  protected async structured<S extends z.ZodType>(
    schema: S,
    system: string,
    prompt: string,
  ): Promise<z.infer<S>> {
    const q = this.sdk.query({
      prompt,
      options: {
        ...this.base(),
        systemPrompt: system,
        maxTurns: 4,
        outputFormat: {
          type: 'json_schema',
          schema: z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>,
        },
      },
    });
    for await (const m of q) {
      if (m.type === 'assistant' && m.error && ACCOUNT_ERRORS[m.error]) {
        throw new Error(ACCOUNT_ERRORS[m.error]);
      }
      if (m.type !== 'result') continue;
      if (m.subtype !== 'success') {
        throw new Error(`Claude Code did not answer: ${m.errors.join(' ') || m.subtype}.`);
      }
      const parsed = schema.safeParse(m.structured_output);
      if (!parsed.success) throw new Error('The model did not return a valid structured answer.');
      return parsed.data;
    }
    throw new Error('Claude Code ended without an answer.');
  }
}
