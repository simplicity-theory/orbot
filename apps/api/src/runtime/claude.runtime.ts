import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { BotEvent, RunContext, TaskBrief } from '@orbot/shared';
import { ClaudeFamilyRuntime, RECON_TOOLS, TERMINAL, TOOLS } from './claude-common.js';

/** The parts of the SDK client ClaudeRuntime uses (tests inject a fake). */
export type ClaudeClient = {
  beta: { messages: Pick<Anthropic['beta']['messages'], 'create' | 'parse'> };
};

export interface ClaudeRuntimeOptions {
  model: string;
  /** Tool-loop iterations before the bot is stopped as failed. */
  maxTurns?: number;
  /** Output tokens per compute unit, for the budget record. */
  tokensPerUnit?: number;
}

// Server-side refusal fallback: if a request is declined, the API re-runs it on a fallback model.
const FALLBACK = {
  betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: 'default' as const,
};

const strict = (tools: typeof TOOLS): Anthropic.Beta.BetaTool[] =>
  tools.map((t) => ({ ...t, strict: true }));
const API_TOOLS = strict(TOOLS);
const API_RECON_TOOLS = strict(RECON_TOOLS);

/**
 * Runs a real bot with Claude, in the task's git worktree. Talks only through the
 * BotRuntime interface, so the rest of ORBOT is unchanged. Secret values never enter
 * the model's context: the bot has no tool that returns one.
 */
export class ClaudeRuntime extends ClaudeFamilyRuntime {
  readonly kind = 'claude';
  private readonly maxTurns: number;
  private readonly tokensPerUnit: number;

  constructor(
    private readonly client: ClaudeClient,
    private readonly opts: ClaudeRuntimeOptions,
  ) {
    super();
    this.maxTurns = opts.maxTurns ?? 40;
    this.tokensPerUnit = opts.tokensPerUnit ?? 10_000;
  }

  // ---------- Bot work ----------

  async *run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent> {
    const system = this.systemPrompt(brief);
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: this.taskPrompt(brief) },
    ];
    let wroteHandover = false;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (ctx.signal.aborted) return;
      const response = await this.client.beta.messages.create(
        {
          model: this.opts.model,
          max_tokens: 16000,
          system,
          tools: brief.task.kind === 'recon' ? API_RECON_TOOLS : API_TOOLS,
          messages,
          cache_control: { type: 'ephemeral' },
          output_config: { effort: 'high' },
          ...FALLBACK,
        },
        { signal: ctx.signal },
      );
      const units = Math.max(1, Math.round(response.usage.output_tokens / this.tokensPerUnit));
      yield { type: 'cost', units };

      if (response.stop_reason === 'refusal') {
        yield {
          type: 'failed',
          reason: `The model declined this task${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}.`,
        };
        return;
      }
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason === 'pause_turn') continue;

      const calls = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      );
      if (!calls.length) {
        messages.push({
          role: 'user',
          content:
            'Use the tools to continue. Finish with write_handover and then done, blocked, failed, send_back or stand_down.',
        });
        continue;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        if (TERMINAL.has(call.name)) {
          if (!wroteHandover) {
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: 'Write the handover first (write_handover).',
            });
            continue;
          }
          yield call.name === 'raise_dispute'
            ? { type: 'dispute', against: String(input['against']), claim: String(input['claim']) }
            : this.terminal(call.name, String(input['reason'] ?? input['summary'] ?? ''));
          return;
        }
        try {
          const { events, output } = await this.tool(call.name, input, brief, ctx);
          if (call.name === 'write_handover') wroteHandover = true;
          for (const ev of events) yield ev;
          results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
        } catch (err) {
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: true,
            content: (err as Error).message,
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    yield { type: 'failed', reason: `Stopped after ${this.maxTurns} turns without finishing.` };
  }

  protected async structured<S extends z.ZodType>(
    schema: S,
    system: string,
    prompt: string,
  ): Promise<z.infer<S>> {
    const response = await this.client.beta.messages.parse({
      model: this.opts.model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
      ...FALLBACK,
    });
    if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
    if (!response.parsed_output)
      throw new Error('The model did not return a valid structured answer.');
    return response.parsed_output as z.infer<S>;
  }
}
