import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { seedDemoForce } from '../src/seed/seed.js';
import { LOGIN_ATTEMPTS } from '../src/auth/auth.controller.js';
import { startTestApp, TEST_PASSPHRASE, type TestApp } from './helpers.js';

const INLINE = "document.body.dataset['ready']='1'";

/** A stand-in for Angular's build output: an index with one inline script and a hashed asset. */
function fakeWebDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'orbot-web-'));
  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html><html><head><title>ORBOT</title><script src="main-ABCDEFGH.js" type="module"></script><script>${INLINE}</script></head><body><app-root></app-root></body></html>`,
  );
  writeFileSync(join(dist, 'main-ABCDEFGH.js'), 'console.log(1)');
  mkdirSync(join(dist, 'media'));
  writeFileSync(join(dist, 'favicon.ico'), 'x');
  return dist;
}

describe('production readiness', () => {
  let t: TestApp;
  const dist = fakeWebDist();
  beforeAll(async () => {
    t = await startTestApp({
      overrides: { ORBOT_WEB_DIST: dist, ORBOT_WEB_ORIGIN: 'http://localhost:4200' },
    });
  });
  afterAll(() => t.close());

  it('serves the web app from the API with a content security policy that allows its one inline script', async () => {
    const hash = `'sha256-${createHash('sha256').update(INLINE).digest('base64')}'`;
    const home = await request(t.app.getHttpServer()).get('/').expect(200);
    expect(home.text).toContain('<app-root>');
    expect(home.headers['content-security-policy']).toContain(`script-src 'self' ${hash}`);
    expect(home.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(home.headers['x-content-type-options']).toBe('nosniff');
    expect(home.headers['x-frame-options']).toBe('DENY');
    expect(home.headers['cache-control']).toBe('no-cache');
    // Deep links are the app shell; the router takes it from there.
    const deep = await request(t.app.getHttpServer())
      .get('/units/abc/bots/def')
      .set('Accept', 'text/html')
      .expect(200);
    expect(deep.text).toContain('<app-root>');
    // Hashed assets are immutable.
    const asset = await request(t.app.getHttpServer()).get('/main-ABCDEFGH.js').expect(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    // The API is untouched: no app shell for unknown API routes, no web policy on API responses.
    await request(t.app.getHttpServer())
      .get('/api/no-such-route')
      .set('Accept', 'text/html')
      .expect(404);
    const api = await t.agent.get('/api/meta').expect(200);
    expect(api.headers['content-security-policy']).toBeUndefined();
    expect(api.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers the health check from both databases', async () => {
    const h = await request(t.app.getHttpServer()).get('/api/health').expect(200);
    expect(h.body).toEqual({
      ok: true,
      record: 'ok',
      secrets: 'ok',
      version: expect.any(String),
      commit: null,
    });
  });

  it('throttles sign-in after repeated failures and clears on success', async () => {
    const api = request(t.app.getHttpServer());
    for (let i = 0; i < LOGIN_ATTEMPTS; i++) {
      await api.post('/api/auth/login').send({ passphrase: 'wrong' }).expect(401);
    }
    const locked = await api
      .post('/api/auth/login')
      .send({ passphrase: TEST_PASSPHRASE })
      .expect(429);
    expect(locked.body.error.message).toMatch(/Too many failed sign-ins/);
    expect(locked.body.error.action).toMatch(/minute/);
  });

  it('ORBOT_SEED=force seeds the units, Overseers, bots and Field Manuals without the demo', async () => {
    const r = await seedDemoForce(t.app, { demo: false });
    expect(r).toEqual({ seeded: true, units: 4, bots: 12, tasks: 0 });
    const orbat = (await t.agent.get('/api/orbat').expect(200)).body;
    expect(orbat.units.map((u: { unit: { name: string } }) => u.unit.name)).toEqual([
      'Engineers',
      'Logistics',
      'Inspection',
      'Guard',
    ]);
    for (const u of orbat.units) {
      expect(u.botCount).toBe(3);
      expect(u.overseer?.isOverseer).toBe(true);
      expect(u.unit.supplyIds).toEqual([]);
    }
    expect((await t.agent.get('/api/operations').expect(200)).body).toEqual([]);
    expect((await t.agent.get('/api/supply').expect(200)).body).toEqual([]);
    const eng = (await t.agent.get(`/api/units/${orbat.units[0].unit.id}`).expect(200)).body;
    expect(eng.fieldManual.length).toBeGreaterThanOrEqual(3);
    expect((await seedDemoForce(t.app, { demo: false })).seeded).toBe(false);
  });
});
