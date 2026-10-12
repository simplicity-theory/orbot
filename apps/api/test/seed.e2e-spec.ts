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
    expect(orbat.units.map((u) => u.unit.name)).toEqual(['Engineers', 'Logistics', 'Inspection', 'Guard']);
    for (const u of orbat.units) {
      expect(u.botCount).toBe(3);
      expect(u.overseer?.isOverseer).toBe(true);
    }
    const eng = orbat.units[0]!;
    expect(eng.currentMission?.goal).toMatch(/rate limiting/);
    expect(eng.attention.map((a) => a.kind).sort()).toEqual(['blocked-bot', 'failed-task']);
    expect(orbat.needsYou).toBe(2);

    const ops = (await t.agent.get('/api/operations').expect(200)).body;
    expect(ops).toHaveLength(1);
    expect(ops[0].phase).toBe('execution');
  });

  it('is idempotent', async () => {
    expect((await seedDemoForce(t.app)).seeded).toBe(false);
  });
});
