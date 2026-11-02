import type { ChatSendResult, OperationDetailView, SupplyView } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { RecordService } from '../src/record/record.service.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * Changing an operation's course: make another repository the main one (once missions are out,
 * they are withdrawn and issued again there), and cancel an operation. Both from the web and in
 * chat; in chat, both need the typed confirmation once work would be thrown away.
 */
describe('Operation course: main repository and cancel', () => {
  let t: TestApp;
  let api: SupplyView;
  let web: SupplyView;

  const op = async (id: string): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
  const chat = async (text: string): Promise<ChatSendResult> => {
    const r = (await t.agent.post('/api/chat/hq').send({ text }).expect(201)).body;
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
  /** An operation with its missions out, waiting on the backbrief (the unit's gate holds it). */
  const launched = async (name: string) => {
    const id = (
      await t.agent
        .post('/api/operations')
        .send({ intent: 'Add a status endpoint.', name, supplyIds: [api.id] })
        .expect(201)
    ).body.id as string;
    return waitFor(async () => {
      const v = await op(id);
      return v.operation.phase === 'backbrief' && v.missions[0]?.backbrief ? v : null;
    });
  };

  beforeAll(async () => {
    t = await startTestApp();
    const repo = async (name: string) =>
      (
        await t.agent
          .post('/api/supply/repositories')
          .send({ name, location: await makeRepo() })
          .expect(201)
      ).body as SupplyView;
    api = await repo('ledger-api');
    web = await repo('ledger-web');
    await makeUnitWithBot(t.app, { gate: 'backbriefs-and-deploys', bots: 2 });
  });
  afterAll(() => t.close());

  it('a new main repository: the missions are withdrawn and issued again there', async () => {
    const before = await launched('Pivot');
    const id = before.operation.id;
    const oldMission = before.missions[0]!.mission.id;
    expect(before.resources.mainRepositoryId).toBe(api.id);

    const after: OperationDetailView = (
      await t.agent
        .post(`/api/operations/${id}/resources/main`)
        .send({ supplyId: web.id })
        .expect(200)
    ).body;
    expect(after.resources.assigned.map((s) => s.name)).toEqual(['ledger-web', 'ledger-api']);
    await settled(t.app);

    const v = await op(id);
    expect(v.operation.phase).toBe('backbrief');
    expect(v.operation.repoSupplyId).toBe(web.id);
    expect(v.resources.mainRepositoryId).toBe(web.id);
    expect(v.missions).toHaveLength(1);
    expect(v.missions[0]!.mission.id).not.toBe(oldMission);
    expect(v.operation.withdrawnMissionIds).toEqual([oldMission]);
    const record = t.app.get(RecordService);
    expect((await record.requireActive('mission', oldMission)).body.status).toBe('withdrawn');
    const [oldBb] = await record.listActive('backbrief', {
      bodyContains: { missionId: oldMission },
    });
    expect(oldBb!.body.status).toBe('rejected');
    // A fresh backbrief for the new mission, and the branch opened in the new main repository.
    expect(v.missions[0]!.backbrief?.status).toBe('awaiting-approval');
    const webPath = web.spec.kind === 'repository' ? web.spec.localPath : '';
    expect(await git(webPath, ['branch', '--list', v.operation.integrationBranch!])).toContain(
      'orbot/op-',
    );
    expect(v.timeline.map((e) => (e.body as { text?: string }).text ?? '')).toContainEqual(
      expect.stringContaining('moves from ledger-api to ledger-web: 1 mission(s) withdrawn'),
    );
    // The old repository is an ordinary resource now: it can be taken off.
    await t.agent
      .post(`/api/operations/${id}/resources/release`)
      .send({ supplyId: api.id })
      .expect(200);
    expect((await op(id)).resources.assigned.map((s) => s.name)).toEqual(['ledger-web']);
  });

  it('in chat: "change the repo from A to B" asks for confirmation, then moves it', async () => {
    const before = await launched('Shift');
    const id = before.operation.id;
    const r = await chat('Change the repo from ledger-api to ledger-web.');
    expect(r.readback.body.items).toEqual([]);
    expect(r.readback.body.pending).toEqual([
      expect.objectContaining({
        summary:
          'Make ledger-web the main repository of Operation Shift (its missions are withdrawn and issued again there)',
      }),
    ]);
    expect((await op(id)).resources.mainRepositoryId).toBe(api.id);
    await confirm(r);
    const v = await op(id);
    expect(v.resources.mainRepositoryId).toBe(web.id);
    expect(v.operation.withdrawnMissionIds).toEqual([before.missions[0]!.mission.id]);
  });

  it('cancel: from the web, and in chat with the confirmation', async () => {
    const a = await launched('Halt');
    const cancelled: OperationDetailView = (
      await t.agent
        .post(`/api/operations/${a.operation.id}/cancel`)
        .send({ note: 'Wrong approach' })
        .expect(200)
    ).body;
    expect(cancelled.operation).toMatchObject({
      phase: 'closed',
      cancelled: { note: 'Wrong approach', by: expect.stringMatching(/^commander:/) },
    });
    const record = t.app.get(RecordService);
    expect((await record.requireActive('mission', a.missions[0]!.mission.id)).body.status).toBe(
      'withdrawn',
    );
    // Closed means closed: no more changes.
    expect(
      (
        await t.agent
          .post(`/api/operations/${a.operation.id}/resources/main`)
          .send({ supplyId: web.id })
          .expect(400)
      ).body.error.message,
    ).toBe('Operation Halt is cancelled.');

    const b = await launched('Recall');
    const r = await chat('Cancel Operation Recall: not needed any more.');
    expect(r.readback.body.pending).toEqual([
      expect.objectContaining({ summary: 'Cancel Operation Recall: not needed any more' }),
    ]);
    await confirm(r);
    expect((await op(b.operation.id)).operation).toMatchObject({
      phase: 'closed',
      cancelled: { note: 'not needed any more' },
    });
  });
});
