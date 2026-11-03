import type {
  ChatSendResult,
  OperationDetailView,
  SupplyView,
  TaskDetailView,
} from '@orbot/shared';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Abort a mission, start it over, start an operation over (D113): the mission's work stands
 * down and stays on record; a restarted mission takes the old one's place in the chain and
 * its unit briefs back afresh; a restarted operation issues every mission again from its plan.
 */
describe('Mission course: abort, start over; operation start over', () => {
  let t: TestApp;
  let repo: SupplyView;
  let unitId: string;

  const op = async (id: string): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
  const chat = async (channel: string, text: string): Promise<ChatSendResult> => {
    const r = (await t.agent.post(`/api/chat/${channel}`).send({ text }).expect(201)).body;
    await settled(t.app);
    return r;
  };
  const confirm = async (r: ChatSendResult) => {
    await t.agent
      .post(`/api/pending/${r.readback.body.pending[0]!.pendingId}/confirm`)
      .send({ phrase: 'confirm' })
      .expect(200);
    await settled(t.app);
  };
  /** An operation whose mission is out and whose backbrief waits for approval. */
  const launched = async (name: string) => {
    const id = (
      await t.agent
        .post('/api/operations')
        .send({ intent: 'Add a status endpoint.', name, supplyIds: [repo.id] })
        .expect(201)
    ).body.id as string;
    return waitFor(async () => {
      const v = await op(id);
      return v.operation.phase === 'backbrief' && v.missions[0]?.backbrief ? v : null;
    });
  };

  beforeAll(async () => {
    t = await startTestApp();
    repo = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'ledger-api', location: await makeRepo() })
        .expect(201)
    ).body;
    unitId = (await makeUnitWithBot(t.app, { gate: 'backbriefs-and-deploys', bots: 2 })).unit
      .entityId;
  });
  afterAll(() => t.close());

  it('abort: the mission is withdrawn, its backbrief rejected, and HQ says the operation waits', async () => {
    const a = await launched('Halt');
    const mission = a.missions[0]!.mission;
    const aborted = (
      await t.agent
        .post(`/api/missions/${mission.id}/abort`)
        .send({ note: 'Wrong brief' })
        .expect(200)
    ).body;
    expect(aborted.status).toBe('withdrawn');
    await settled(t.app);
    const v = await op(a.operation.id);
    expect(v.operation.phase).toBe('backbrief');
    expect(v.missions[0]!.backbrief?.status).toBe('rejected');
    expect(v.timeline.map((e) => (e.body as { text?: string }).text ?? '')).toContainEqual(
      expect.stringMatching(
        /^Mission aborted: “.*” \(Engineers\), Wrong brief\. 0 task\(s\) stood down.*start the mission over, or cancel the operation\.$/,
      ),
    );
    // Aborted means aborted: not twice.
    const again = await t.agent.post(`/api/missions/${mission.id}/abort`).send({}).expect(409);
    expect(again.body.error.action).toBe('A withdrawn mission can be started over.');
  });

  it('start over: a new mission in the old one’s place, a fresh backbrief; the old one is withdrawn', async () => {
    const a = await launched('Redo');
    const old = a.missions[0]!.mission;
    const fresh = (
      await t.agent.post(`/api/missions/${old.id}/restart`).send({ note: 'Again' }).expect(200)
    ).body;
    expect(fresh.id).not.toBe(old.id);
    expect(fresh).toMatchObject({ goal: old.goal, unitId: old.unitId, stage: old.stage });
    const v = await waitFor(async () => {
      const x = await op(a.operation.id);
      return x.missions[0]?.backbrief?.missionId === fresh.id ? x : null;
    });
    expect(v.operation.missionIds).toEqual([fresh.id]);
    expect(v.operation.withdrawnMissionIds).toEqual([old.id]);
    expect(v.missions[0]!.backbrief?.status).toBe('awaiting-approval');
    const record = t.app.get(RecordService);
    expect((await record.requireActive('mission', old.id)).body.status).toBe('withdrawn');
    expect(v.timeline.map((e) => (e.body as { text?: string }).text ?? '')).toContainEqual(
      expect.stringMatching(/^Mission started over: “.*” issued again to Engineers \(Again\)/),
    );
  });

  it('the operation starts over: every mission withdrawn and issued again from the same plan', async () => {
    const a = await launched('Encore');
    const old = a.missions[0]!.mission.id;
    await t.agent
      .post(`/api/operations/${a.operation.id}/restart`)
      .send({ note: 'From the top' })
      .expect(200);
    const v = await waitFor(async () => {
      const x = await op(a.operation.id);
      return x.operation.phase === 'backbrief' && x.missions[0]?.mission.id !== old ? x : null;
    });
    expect(v.operation.withdrawnMissionIds).toEqual([old]);
    expect(v.missions).toHaveLength(1);
    expect(v.missions[0]!.mission.goal).toBe(a.missions[0]!.mission.goal);
    expect(v.timeline.map((e) => (e.body as { text?: string }).text ?? '')).toContainEqual(
      expect.stringContaining(
        'Operation Encore started over: From the top. 1 mission(s) withdrawn',
      ),
    );
  });

  it('the task shows its chain of command: operation, mission and the mission’s tasks', async () => {
    const a = await launched('Chain');
    const bb = a.missions[0]!.backbrief!;
    await t.agent
      .post(`/api/backbriefs/${bb.id}/approve`)
      .send({ expectedVersion: bb.version })
      .expect(200);
    const v = await waitFor(async () => {
      const x = await op(a.operation.id);
      return x.missions[0]!.tasks.length ? x : null;
    });
    const task = v.missions[0]!.tasks[0]!;
    const d: TaskDetailView = (await t.agent.get(`/api/tasks/${task.id}`).expect(200)).body;
    expect(d.operation?.name).toBe('Chain');
    expect(d.mission?.id).toBe(v.missions[0]!.mission.id);
    expect(d.missionTasks.map((x) => x.id)).toContain(task.id);
  });

  it('in chat: abort and start over name the mission by its unit; both take the confirmation', async () => {
    const a = await launched('Words');
    const r = await chat('hq', "Abort Engineers' mission in Operation Words: wrong plan.");
    expect(r.readback.body.pending).toEqual([
      expect.objectContaining({
        summary: expect.stringMatching(
          /^Abort the mission “.*” \(its work stands down\): wrong plan$/,
        ),
      }),
    ]);
    await confirm(r);
    const record = t.app.get(RecordService);
    expect((await record.requireActive('mission', a.missions[0]!.mission.id)).body.status).toBe(
      'withdrawn',
    );
    const r2 = await chat(unitId, 'Start the mission in Operation Words over.');
    expect(r2.readback.body.pending).toEqual([
      expect.objectContaining({ summary: expect.stringMatching(/^Start the mission “.*” over/) }),
    ]);
    await confirm(r2);
    const v = await op(a.operation.id);
    expect(v.operation.withdrawnMissionIds).toEqual([a.missions[0]!.mission.id]);
    expect(v.missions[0]!.mission.status).not.toBe('withdrawn');

    const r3 = await chat('hq', 'Start Operation Words over.');
    expect(r3.readback.body.pending).toEqual([
      expect.objectContaining({
        summary: 'Start Operation Words over (its missions are withdrawn and issued again)',
      }),
    ]);
  });
});
