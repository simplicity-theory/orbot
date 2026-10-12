import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordEvent, TaskDetailView, TaskView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { DOCS_BRANCH } from '../src/documents/document-store.js';
import { BriefingService } from '../src/overseer/briefing.service.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Phase 2 "done when": a fresh bot finishes another bot's half-done task using
 * only the unit's documents. Two negative controls withhold the documents and
 * show the fresh bot then cannot finish.
 */
describe('Phase 2: a fresh bot finishes a half-done task from the unit documents alone', () => {
  let t: TestApp;
  let repoId: string;
  let repoLocalPath: string;

  beforeAll(async () => {
    t = await startTestApp();
    const repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body;
    repoId = repo.id;
    repoLocalPath = repo.spec.localPath;
  });
  afterAll(() => t.close());

  /** E-1 does part 1, hands over and stands down; a new bot replaces it. */
  async function halfDone(unitName: string) {
    const { unit, bot } = await makeUnitWithBot(t.app, { name: unitName, supplyIds: [repoId] });
    const task: TaskView = (
      await t.agent
        .post('/api/tasks')
        .send({
          unitId: unit.entityId,
          botId: bot.entityId,
          title: 'Add audit logging',
          repoSupplyId: repoId,
          scenario: 'relay',
        })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);

    const fresh = (
      await t.agent
        .post(`/api/units/${unit.entityId}/bots`)
        .send({ role: 'Developer', replacesBotId: bot.entityId, reason: 'E-1 rotated out' })
        .expect(201)
    ).body as { id: string; callsign: string };
    await settled(t.app);
    return {
      unitId: unit.entityId,
      oldBotId: bot.entityId,
      taskId: task.id,
      number: task.number,
      fresh,
    };
  }

  async function finish(taskId: string): Promise<TaskDetailView> {
    await t.agent.post(`/api/tasks/${taskId}/run`).expect(202);
    await settled(t.app);
    return (await t.agent.get(`/api/tasks/${taskId}`).expect(200)).body;
  }

  describe('with the unit documents', () => {
    let relay: Awaited<ReturnType<typeof halfDone>>;
    let before: TaskDetailView;
    let after: TaskDetailView;

    beforeAll(async () => {
      relay = await halfDone('Engineers');
      before = (await t.agent.get(`/api/tasks/${relay.taskId}`).expect(200)).body;
      after = await finish(relay.taskId);
    });

    it('E-1 left the task half done, with a handover, and stood down', () => {
      const statuses = before.versions.map((v) => (v.body as { status: string }).status);
      expect(statuses).toContain('stood-down');
      expect(before.handover?.markdown).toContain('## Next steps');
      expect(before.task.botId).toBe(relay.fresh.id);
      expect(before.task.status).toBe('queued');
    });

    it('the Overseer promoted the lesson from the handover into the Field Manual, with provenance', async () => {
      const unit = (await t.agent.get(`/api/units/${relay.unitId}`).expect(200)).body;
      const entry = unit.fieldManual.find((e: { body: string }) =>
        e.body.includes('Prefix commit messages with `[ENG]`'),
      );
      expect(entry).toBeDefined();
      expect(entry.sources).toEqual([
        expect.objectContaining({
          kind: 'handover',
          id: before.handover!.id,
          label: `Task #${relay.number} handover v1`,
        }),
      ]);
    });

    it('the replacement is a fresh bot: nothing on its record before this task', async () => {
      const events = await t.app
        .get(RecordService)
        .listEvents({ botId: relay.fresh.id, limit: 1000 });
      const firstRun = events.findIndex((e) => e.kind === 'run.started');
      expect(firstRun).toBeGreaterThanOrEqual(0);
      expect(events.slice(0, firstRun).every((e) => e.kind === 'task.reassigned')).toBe(true);
      expect(relay.fresh.id).not.toBe(relay.oldBotId);
    });

    it('was briefed from the unit documents: the handover and the Field Manual', () => {
      const briefs = after.events.filter(
        (e) => e.kind === 'task.briefed',
      ) as RecordEvent<'task.briefed'>[];
      const last = briefs.at(-1)!;
      expect(last.botId).toBe(relay.fresh.id);
      expect(last.body.handoverId).toBe(after.handover!.id);
      expect(last.body.fieldManualEntryIds.length).toBeGreaterThan(0);
      const steps = after.events
        .filter((e) => e.kind === 'bot.step' && e.botId === relay.fresh.id)
        .map((e) => (e.body as { action: string }).action);
      expect(steps).toEqual(
        expect.arrayContaining(['resume', 'read-handover', 'read-field-manual']),
      );
    });

    it('finished the task: Done, with both bots’ work on the branch in the unit’s convention', async () => {
      expect(after.task.status).toBe('done');
      const branch = after.task.workspace!.branch;
      const log = (await git(repoLocalPath, ['log', '--format=%s', `main..${branch}`])).split('\n');
      expect(log).toEqual([
        `[ENG] Task #${relay.number}: part 2 by ${relay.fresh.callsign}`,
        `[ENG] Task #${relay.number}: part 1 by E-1`,
      ]);
      const part2 = await git(repoLocalPath, [
        'show',
        `${branch}:orbot/task-${relay.number}/part-2.md`,
      ]);
      expect(part2).toContain('Part 2 completes what part 1 started.');
    });

    it('the documents it used are Markdown in the repository, on the unit-docs branch', async () => {
      const files = await git(repoLocalPath, [
        'ls-tree',
        '-r',
        '--name-only',
        DOCS_BRANCH,
        '.orbot/units/engineers',
      ]);
      expect(files.split('\n')).toEqual(
        expect.arrayContaining([
          '.orbot/units/engineers/field-manual.md',
          `.orbot/units/engineers/handovers/task-${relay.number}.md`,
          '.orbot/units/engineers/standing-orders.md',
        ]),
      );
      const fm = await git(repoLocalPath, [
        'show',
        `${DOCS_BRANCH}:.orbot/units/engineers/field-manual.md`,
      ]);
      expect(fm).toContain('Prefix commit messages with `[ENG]`');
      expect(
        readFileSync(
          join(t.config.workspacesDir, 'docs', repoId, '.orbot/units/engineers/README.md'),
          'utf8',
        ),
      ).toContain('War Diary');
    });
  });

  describe('negative controls: without the documents the fresh bot cannot finish', () => {
    afterEach(() => vi.restoreAllMocks());

    it('handover withheld → blocked, naming what is missing', async () => {
      const relay = await halfDone('Control Alpha');
      const briefing = t.app.get(BriefingService);
      const real = briefing.knowledge.bind(briefing);
      vi.spyOn(briefing, 'knowledge').mockImplementation(async (u, task) => ({
        ...(await real(u, task)),
        lastHandover: null,
      }));
      const d = await finish(relay.taskId);
      expect(d.task.status).toBe('blocked');
      expect(d.task.statusReason).toMatch(/No handover for task/);
    });

    it('Field Manual withheld (brief and search) → blocked, naming what is missing', async () => {
      const relay = await halfDone('Control Bravo');
      const briefing = t.app.get(BriefingService);
      const real = briefing.knowledge.bind(briefing);
      vi.spyOn(briefing, 'knowledge').mockImplementation(async (u, task) => ({
        ...(await real(u, task)),
        fieldManual: [],
      }));
      vi.spyOn(briefing, 'search').mockResolvedValue([]);
      const d = await finish(relay.taskId);
      expect(d.task.status).toBe('blocked');
      expect(d.task.statusReason).toMatch(/Field Manual has no commit-message convention/);
    });
  });
});
