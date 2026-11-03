import request from 'supertest';
import { RuntimeRegistry } from '../src/runtime/runtime.registry.js';
import { seedDemoForce } from '../src/seed/seed.js';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * The simulated runtime is for development, demos and tests. In production it is not installed
 * unless asked for (ORBOT_SIMULATED=off here stands in for production's `auto`, which the
 * config unit test covers), so no bot can be put on it and the demo cannot be seeded by mistake.
 */
describe('production: no simulated runtime unless asked for', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({
      overrides: { ORBOT_SIMULATED: 'off', ORBOT_RUNTIME: 'claude-code', ORBOT_CLAUDE_CODE: 'on' },
    });
  });
  afterAll(() => t.close());

  it('installs only the configured runtime', async () => {
    expect(t.config.simulated).toBe(false);
    expect(t.app.get(RuntimeRegistry).kinds()).toEqual(['claude-code']);
    const meta = (await request(t.app.getHttpServer()).get('/api/meta').expect(200)).body;
    expect(meta.runtimes).toEqual(['claude-code']);
  });

  it('seeds the force on that runtime, and refuses the demo', async () => {
    await expect(seedDemoForce(t.app, { demo: true })).rejects.toThrow(
      /needs the simulated runtime, which is not installed here/,
    );
    const r = await seedDemoForce(t.app, { demo: false });
    expect(r.seeded).toBe(true);
    const orbat = (await t.agent.get('/api/orbat').expect(200)).body;
    for (const u of orbat.units) {
      for (const b of [...u.bots, u.overseer]) expect(b.runtime).toBe('claude-code');
    }
  });

  it('no bot can be switched to it', async () => {
    const r = await t.agent
      .put('/api/bots/runtime')
      .send({ runtime: 'simulated', reason: 'trying' })
      .expect(404);
    expect(r.body.error.message).toBe('No bot runtime called "simulated" is installed.');
  });
});
