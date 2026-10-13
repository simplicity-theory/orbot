import type { ChatSendResult, TaskDetailView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { ClaudeRuntime, type ClaudeClient } from '../src/runtime/claude.runtime.js';
import { RuntimeRegistry } from '../src/runtime/runtime.registry.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

type Block = Record<string, unknown>;
const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});

/**
 * A scripted stand-in for the Anthropic API: replays a fixed conversation and records
 * every request ORBOT sends, so the test can check what the model would have seen.
 */
class FakeClaude {
  readonly requests: unknown[] = [];
  private turns: Block[][];
  constructor(
    turns: Block[][],
    private readonly parsed: unknown = null,
  ) {
    this.turns = [...turns];
  }
  readonly beta = {
    messages: {
      create: async (params: unknown) => {
        this.requests.push(params);
        const content = this.turns.shift() ?? [];
        return {
          content,
          stop_reason: content.some((b) => b['type'] === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_details: null,
          usage: { output_tokens: 12_000 },
        };
      },
      parse: async (params: unknown) => {
        this.requests.push(params);
        return { parsed_output: this.parsed, stop_reason: 'end_turn', content: [] };
      },
    },
  };
}

describe('ClaudeRuntime (against a scripted API)', () => {
  let t: TestApp;
  let repoId: string;
  let unitId: string;
  let botId: string;
  const SECRET = 'ghp-should-never-reach-the-model-0123456789';

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

  it('runs a bot through the tool loop in its worktree, onto the record, and never shows the model a secret', async () => {
    const fake = new FakeClaude([
      [
        { type: 'text', text: 'Reading the brief.' },
        toolUse('t1', 'write_file', { path: 'src/limit.js', content: 'export const LIMIT = 5;\n' }),
        toolUse('t2', 'log_diary', {
          category: 'decision',
          text: 'Limit of 5 per minute, per the brief.',
        }),
      ],
      [
        toolUse('t3', 'commit', { message: 'Add login rate limit' }),
        toolUse('t4', 'sitrep', { text: 'Limit committed.' }),
      ],
      // Trying to finish before the handover is refused by the runtime…
      [toolUse('t5', 'done', { summary: 'Too early' })],
      [
        toolUse('t6', 'write_handover', {
          state: 'Limit added and committed.',
          nextSteps: ['Inspection to test it'],
          triedAndFailed: [],
          openProblems: [],
          flagsForSuccessor: ['Limits live in src/limit.js.'],
        }),
      ],
      [toolUse('t7', 'done', { summary: 'Rate limit added.' })],
    ]);
    t.app
      .get(RuntimeRegistry)
      .register(new ClaudeRuntime(fake as unknown as ClaudeClient, { model: 'claude-opus-5-5' }));
    await t.agent
      .put(`/api/bots/${botId}/runtime`)
      .send({ runtime: 'claude', reason: 'Real work' })
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
    const kinds = d.events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'bot.step',
        'diary.entry',
        'artifact',
        'sitrep',
        'cost',
        'run.finished',
      ]),
    );
    expect(d.handover?.markdown).toContain('Limits live in src/limit.js.');
    expect(await git(d.task.workspace!.path, ['log', '-1', '--format=%s'])).toBe(
      'Add login rate limit',
    );
    expect(await git(d.task.workspace!.path, ['show', 'HEAD:src/limit.js'])).toBe(
      'export const LIMIT = 5;',
    );

    // What the model saw: the brief and tool results — never the secret value.
    const sent = JSON.stringify(fake.requests);
    expect(sent).toContain('Add a login rate limit');
    expect(sent).toContain('Write the handover first');
    expect(sent).not.toContain(SECRET);
    expect((fake.requests[0] as { model: string }).model).toBe('claude-opus-5-5');
    expect((fake.requests[0] as { fallbacks: string }).fallbacks).toBe('default');
  });

  it('refuses paths outside the workspace', async () => {
    const fake = new FakeClaude([
      [toolUse('a', 'read_file', { path: '../../etc/passwd' })],
      [
        toolUse('b', 'write_handover', {
          state: 's',
          nextSteps: [],
          triedAndFailed: [],
          openProblems: [],
          flagsForSuccessor: [],
        }),
      ],
      [toolUse('c', 'failed', { reason: 'Could not read it.' })],
    ]);
    t.app
      .get(RuntimeRegistry)
      .register(new ClaudeRuntime(fake as unknown as ClaudeClient, { model: 'claude-opus-5-5' }));
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title: 'Try to escape', repoSupplyId: repoId })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    expect(JSON.stringify(fake.requests[1])).toContain('Outside the workspace');
    expect((await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body.task.status).toBe(
      'failed',
    );
  });

  it('raise_dispute (after a handover) stops the task as disputed, for HQ to rule on', async () => {
    const fake = new FakeClaude([
      [
        toolUse('d1', 'write_handover', {
          state: 'Stopped before changing the limit.',
          nextSteps: ['Follow the ruling'],
          triedAndFailed: [],
          openProblems: [],
          flagsForSuccessor: [],
        }),
      ],
      [toolUse('d2', 'raise_dispute', { against: 'Guard', claim: 'Guard caps logins at 5.' })],
    ]);
    t.app
      .get(RuntimeRegistry)
      .register(new ClaudeRuntime(fake as unknown as ClaudeClient, { model: 'claude-opus-5-5' }));
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId, botId, title: 'Raise the login limit', repoSupplyId: repoId })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    const d: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
    expect(d.task.status).toBe('blocked');
    expect(d.task.statusReason).toBe('Disputed with Guard: Guard caps logins at 5.');
    expect(d.events.map((e) => e.kind)).toContain('dispute.raised');
    expect(JSON.stringify(fake.requests[0])).toContain('raise_dispute');
  });

  it('recon: no tool that changes the workspace; the report is filed with the unit', async () => {
    const fake = new FakeClaude([
      [toolUse('r1', 'write_file', { path: 'x.md', content: 'sneaky' })],
      [
        toolUse('r2', 'file_report', {
          title: 'Recon: where logins are checked',
          markdown: '# Findings\n\n- Only README.md exists.',
        }),
      ],
      [
        toolUse('r3', 'write_handover', {
          state: 'Report filed.',
          nextSteps: [],
          triedAndFailed: [],
          openProblems: [],
          flagsForSuccessor: [],
        }),
      ],
      [toolUse('r4', 'done', { summary: 'Recon complete.' })],
    ]);
    t.app
      .get(RuntimeRegistry)
      .register(new ClaudeRuntime(fake as unknown as ClaudeClient, { model: 'claude-opus-5-5' }));
    // A unit of its own: the earlier bot is still blocked on its dispute.
    const scouts = await makeUnitWithBot(t.app, {
      name: 'Scouts',
      prefix: 'S',
      supplyIds: [repoId],
    });
    await t.agent
      .put(`/api/bots/${scouts.bot.entityId}/runtime`)
      .send({ runtime: 'claude', reason: 'Real recon' })
      .expect(200);
    await settled(t.app);
    const task = (
      await t.agent
        .post('/api/recon')
        .send({ unitId: scouts.unit.entityId, question: 'Where are logins checked?' })
        .expect(201)
    ).body;
    await settled(t.app);
    const first = fake.requests[0] as { tools: { name: string }[]; system: string };
    const names = first.tools.map((x) => x.name);
    expect(names).toContain('file_report');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('commit');
    expect(first.system).toContain('This is a recon task: read-only.');
    expect(JSON.stringify(fake.requests[1])).toContain('Recon is read-only');
    const d: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
    expect(d.task.status).toBe('done');
    expect(d.report?.title).toBe('Recon: where logins are checked');
  });

  it('interprets chat through the model with structured output, validated by ORBOT', async () => {
    const fake = new FakeClaude([], {
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
    });
    t.app
      .get(RuntimeRegistry)
      .register(new ClaudeRuntime(fake as unknown as ClaudeClient, { model: 'claude-opus-5-5' }));
    const overseer = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body.overseer;
    await t.agent
      .put(`/api/bots/${overseer.id}/runtime`)
      .send({ runtime: 'claude', reason: 'Model Overseer' })
      .expect(200);
    const r: ChatSendResult = (
      await t.agent
        .post(`/api/chat/${unitId}`)
        .send({ text: 'From now on, rebase before handing over.' })
        .expect(201)
    ).body;
    expect(r.readback.body.text).toBe('Wilco.');
    const unit = (await t.agent.get(`/api/units/${unitId}`).expect(200)).body;
    expect(unit.unit.standingOrders.map((o: { text: string }) => o.text)).toContain(
      'Rebase before handing over.',
    );
  });

  it('is listed as an installed runtime only when configured (here: by the test)', async () => {
    const meta = (await t.agent.get('/api/meta').expect(200)).body;
    expect(meta.runtimes).toEqual(['simulated', 'claude']);
  });
});
