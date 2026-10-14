import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSendResult, TaskDetailView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import {
  ClaudeCodeRuntime,
  claudeCodeEnv,
  type ClaudeCodeSdk,
} from '../src/runtime/claude-code.runtime.js';
import { RuntimeRegistry } from '../src/runtime/runtime.registry.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

type Call = [name: string, input: Record<string, unknown>];
interface FakeTool {
  name: string;
  handler: (
    input: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    content: { text: string }[];
    isError?: boolean;
  }>;
}

/**
 * A scripted stand-in for Claude Code: each turn calls ORBOT's MCP tool handlers the way the
 * real process would, and everything ORBOT passed in (options, prompts, tool results) is kept
 * so the test can check what the model would have seen.
 */
class FakeClaudeCode {
  readonly calls: { prompt: string; options: Options; results: string[] }[] = [];
  private server: { tools: FakeTool[] } | null = null;
  constructor(
    private readonly turns: Call[][],
    private readonly opts: { structured?: unknown; error?: string } = {},
  ) {}

  readonly sdk: ClaudeCodeSdk = {
    createSdkMcpServer: ((o: { tools: FakeTool[] }) => {
      this.server = { tools: o.tools };
      return { type: 'sdk', name: 'orbot', instance: {} };
    }) as unknown as ClaudeCodeSdk['createSdkMcpServer'],
    query: ({ prompt, options }) => this.run(prompt, options ?? {}),
  };

  private async *run(prompt: string | AsyncIterable<SDKUserMessage>, options: Options) {
    const call = { prompt: '', options, results: [] as string[] };
    this.calls.push(call);
    if (typeof prompt === 'string') {
      call.prompt = prompt;
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: this.opts.structured,
      } as never;
      return;
    }
    const first = await prompt[Symbol.asyncIterator]().next();
    call.prompt = String((first.value as SDKUserMessage).message.content);
    if (this.opts.error) {
      yield {
        type: 'assistant',
        error: this.opts.error,
        parent_tool_use_id: null,
        message: { id: 'm-err', usage: { output_tokens: 0 } },
      } as never;
      return;
    }
    for (const [i, turn] of this.turns.entries()) {
      for (const [name, input] of turn) {
        const tool = this.server!.tools.find((x) => x.name === name);
        const r = tool
          ? await tool.handler(input, {})
          : { content: [{ text: `No such tool: ${name}` }], isError: true };
        call.results.push(`${name}: ${r.content[0]!.text}`);
      }
      // The same API message, delivered as two SDK messages: its tokens count once.
      for (let k = 0; k < 2; k++) {
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { id: `m${i}`, usage: { output_tokens: 12_000 } },
        } as never;
      }
    }
    yield { type: 'result', subtype: 'success' } as never;
  }
}

const handover = {
  state: 'Done and committed.',
  nextSteps: ['Inspection to test it'],
  triedAndFailed: [],
  openProblems: [],
  flagsForSuccessor: ['Limits live in src/limit.js.'],
};

describe('ClaudeCodeRuntime (the Commander’s own Claude plan, against a scripted Claude Code)', () => {
  let t: TestApp;
  let repoId: string;
  let unitId: string;
  let botId: string;
  const SECRET = 'ghp-should-never-reach-the-model-0123456789';

  const install = (fake: FakeClaudeCode) =>
    t.app.get(RuntimeRegistry).register(
      new ClaudeCodeRuntime(
        {
          model: 'claude-opus-5-5',
          env: {
            PATH: '/usr/bin',
            HOME: '/home/cmdr',
            ANTHROPIC_API_KEY: 'sk-ant-would-bill-the-api',
            ORBOT_SECRETS_KEY: 'orbot-key-material',
          },
        },
        fake.sdk,
      ),
    );

  beforeAll(async () => {
    t = await startTestApp();
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    await t.agent
      .post('/api/supply/credentials')
      .send({ name: 'push-token', value: SECRET })
      .expect(201);
    const fx = await makeUnitWithBot(t.app, { supplyIds: [repoId] });
    unitId = fx.unit.entityId;
    botId = fx.bot.entityId;
  });
  afterAll(() => t.close());

  it('keeps ORBOT’s keys and any API key out of the Claude Code process', () => {
    const env = claudeCodeEnv({
      PATH: '/bin',
      HOME: '/h',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      ANTHROPIC_API_KEY: 'sk',
      ORBOT_COMMANDER_PASSPHRASE: 'pass',
      ORBOT_DB_PASSWORD: 'pw',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'orbot/0.1',
    });
  });

  it('runs a bot in its worktree with only ORBOT’s tools, onto the record, never showing a secret', async () => {
    const fake = new FakeClaudeCode([
      [
        ['write_file', { path: 'src/limit.js', content: 'export const LIMIT = 5;\n' }],
        ['log_diary', { category: 'decision', text: 'Limit of 5 per minute, per the brief.' }],
      ],
      [
        ['commit', { message: 'Add login rate limit' }],
        ['sitrep', { text: 'Limit committed.' }],
      ],
      // Trying to finish before the handover is refused by the runtime…
      [['done', { summary: 'Too early' }]],
      [['write_handover', handover]],
      [['done', { summary: 'Rate limit added.' }]],
    ]);
    install(fake);
    await t.agent
      .put(`/api/bots/${botId}/runtime`)
      .send({ runtime: 'claude-code', reason: 'On my Claude plan' })
      .expect(200);

    const task = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId,
          botId,
          title: 'Add a login rate limit',
          repoSupplyId: repoId,
          credentialNames: ['push-token'],
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    const d: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;

    expect(d.task.status).toBe('done');
    expect(d.task.statusReason).toBe('Rate limit added.');
    expect(d.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['bot.step', 'diary.entry', 'artifact', 'sitrep', 'cost']),
    );
    // One cost entry per API message, not per SDK message.
    expect(d.events.filter((e) => e.kind === 'cost')).toHaveLength(5);
    expect(d.handover?.markdown).toContain('Limits live in src/limit.js.');
    expect(await git(d.task.workspace!.path, ['show', 'HEAD:src/limit.js'])).toBe(
      'export const LIMIT = 5;',
    );

    const [call] = fake.calls;
    const o = call!.options;
    expect(o.cwd).toBe(d.task.workspace!.path);
    expect(o.tools).toEqual([]); // none of Claude Code's own tools
    expect(o.settingSources).toEqual([]); // no settings, hooks or CLAUDE.md from the machine
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.allowedTools).toContain('mcp__orbot__write_file');
    expect(o.allowedTools!.every((n) => n.startsWith('mcp__orbot__'))).toBe(true);
    expect(o.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/cmdr',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'orbot/0.1',
    });
    expect(o.model).toBe('claude-opus-5-5');
    expect(call!.results).toContain('done: Write the handover first (write_handover).');
    const seen = JSON.stringify({ prompt: call!.prompt, sys: o.systemPrompt, r: call!.results });
    expect(seen).toContain('Add a login rate limit');
    expect(seen).not.toContain(SECRET);
  });

  it('recon gets no tool that changes the workspace', async () => {
    const fake = new FakeClaudeCode([
      [['write_file', { path: 'x.md', content: 'sneaky' }]],
      [['file_report', { title: 'Recon: logins', markdown: '# Findings\n\n- README only.' }]],
      [['write_handover', { ...handover, flagsForSuccessor: [] }]],
      [['done', { summary: 'Recon complete.' }]],
    ]);
    install(fake);
    const scouts = await makeUnitWithBot(t.app, {
      name: 'Scouts',
      prefix: 'S',
      supplyIds: [repoId],
    });
    await t.agent
      .put(`/api/bots/${scouts.bot.entityId}/runtime`)
      .send({ runtime: 'claude-code', reason: 'Real recon' })
      .expect(200);
    await settled(t.app);
    const task = (
      await t.agent
        .post('/api/recon')
        .send({ unitId: scouts.unit.entityId, question: 'Where are logins checked?' })
        .expect(201)
    ).body;
    await settled(t.app);
    const o = fake.calls[0]!.options;
    expect(o.allowedTools).toContain('mcp__orbot__file_report');
    expect(o.allowedTools).not.toContain('mcp__orbot__write_file');
    expect(fake.calls[0]!.results[0]).toBe('write_file: No such tool: write_file');
    const d: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
    expect(d.task.status).toBe('done');
    expect(d.report?.title).toBe('Recon: logins');
  });

  it('interprets chat with structured output, validated by ORBOT', async () => {
    const fake = new FakeClaudeCode([], {
      structured: {
        kinds: ['rule-change'],
        answer: null,
        actions: [
          {
            kind: 'rule-change',
            unitId,
            removeOrders: [],
            addOrders: ['Rebase before handing over.'],
            removeRoe: [],
            addRoe: [],
          },
        ],
        musings: [],
        missing: [],
        unclear: [],
      },
    });
    install(fake);
    const overseer = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body.overseer;
    await t.agent
      .put(`/api/bots/${overseer.id}/runtime`)
      .send({ runtime: 'claude-code', reason: 'Overseer on my plan' })
      .expect(200);
    const r: ChatSendResult = (
      await t.agent
        .post(`/api/chat/${unitId}`)
        .send({ text: 'From now on, rebase before handing over.' })
        .expect(201)
    ).body;
    expect(r.readback.body.text).toBe('Wilco.');
    const o = fake.calls[0]!.options;
    expect(o.outputFormat?.type).toBe('json_schema');
    expect(o.tools).toEqual([]);
    const unit = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body;
    expect(unit.unit.standingOrders.map((x: { text: string }) => x.text)).toContain(
      'Rebase before handing over.',
    );
  });

  it('a usage limit on the Claude plan blocks the task with what to do, instead of failing it', async () => {
    install(new FakeClaudeCode([], { error: 'rate_limit' }));
    const guard = await makeUnitWithBot(t.app, { name: 'Guard', prefix: 'G', supplyIds: [repoId] });
    await t.agent
      .put(`/api/bots/${guard.bot.entityId}/runtime`)
      .send({ runtime: 'claude-code', reason: 'On my Claude plan' })
      .expect(200);
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: guard.unit.entityId,
          botId: guard.bot.entityId,
          title: 'Check the limit',
          repoSupplyId: repoId,
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    const d: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
    expect(d.task.status).toBe('blocked');
    expect(d.task.statusReason).toContain('usage limit was reached');
  });

  it('is listed as an installed runtime when turned on (here: by the test)', async () => {
    const meta = (await t.agent.get('/api/meta').expect(200)).body;
    expect(meta.runtimes).toEqual(['simulated', 'claude-code']);
  });

  it('switches every bot in the force onto one runtime, on the record', async () => {
    await t.agent.put('/api/bots/runtime').send({ runtime: 'nope', reason: 'x' }).expect(404);
    const r = (
      await t.agent
        .put('/api/bots/runtime')
        .send({ runtime: 'simulated', reason: 'Back to the simulator' })
        .expect(200)
    ).body;
    expect(r.switched).toBeGreaterThan(0);
    const again = (
      await t.agent
        .put('/api/bots/runtime')
        .send({ runtime: 'simulated', reason: 'Again' })
        .expect(200)
    ).body;
    expect(again.switched).toBe(0);
    const history = (await t.agent.get(`/api/record/${botId}/history`).expect(200)).body;
    expect(JSON.stringify(history)).toContain('Back to the simulator');
  });
});
