import type { OrbatView } from '@orbot/shared';
import { seedDemoForce } from '../src/seed/seed.js';
import { startTestApp, type TestApp } from './helpers.js';

describe('demo seed', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(() => t.close());

  it('creates four units with ~3 bots each and one operation in flight, and surfaces attention on the ORBAT', async () => {
    const r = await seedDemoForce(t.app);
    expect(r.seeded).toBe(true);
    const orbat: OrbatView = (await t.agent.get('/api/orbat').expect(200)).body;
    expect(orbat.units.map((u) => u.unit.name)).toEqual([
      'Engineers',
      'Logistics',
      'Inspection',
      'Guard',
    ]);
    for (const u of orbat.units) {
      expect(u.botCount).toBe(3);
      expect(u.overseer?.isOverseer).toBe(true);
    }
    const eng = orbat.units[0]!;
    expect(eng.currentMission?.goal).toMatch(/rate limiting/);
    expect(eng.attention.map((a) => a.kind).sort()).toEqual([
      'awaiting-approval',
      'blocked-bot',
      'failed-task',
    ]);
    expect(eng.backbriefs.map((b) => b.mission.goal)).toEqual(['Harden session handling']);
    expect(orbat.needsYou).toBe(5);

    // Inspection's gate is "escalations only": its plan ran without waiting for approval.
    const inspection = (await t.agent.get(`/api/units/${orbat.units[2]!.unit.id}`).expect(200))
      .body;
    expect(inspection.missions[0].mission.status).toBe('done');
    expect(inspection.missions[0].backbrief.decision.outcome).toBe('auto-approved');

    // Guard has two tasks held up by a standing order and by missing supply.
    const guard = orbat.units[3]!;
    expect(guard.attention.map((a) => a.kind).sort()).toEqual(['blocked-bot', 'blocked-bot']);
    const chat = (await t.agent.get(`/api/chat/${eng.unit.id}`).expect(200)).body;
    expect(chat.items.map((i: { kind: string }) => i.kind)).toEqual([
      'chat.message',
      'chat.readback',
    ]);

    // Engineers has a curated Field Manual and a cold-start result.
    const engineers = (await t.agent.get(`/api/units/${eng.unit.id}`).expect(200)).body;
    expect(engineers.fieldManual.length).toBeGreaterThanOrEqual(3);
    expect(engineers.coldStart.body.score).toBeGreaterThanOrEqual(0);
    expect(engineers.docsMirror).toEqual(
      expect.objectContaining({ branch: 'orbot/unit-docs', path: '.orbot/units/engineers' }),
    );

    const ops = (await t.agent.get('/api/operations').expect(200)).body;
    expect(ops).toHaveLength(1);
    expect(ops[0].phase).toBe('execution');
  });

  it('is idempotent', async () => {
    expect((await seedDemoForce(t.app)).seeded).toBe(false);
  });
});
