import type { DocumentView, SearchHit, VersionDiff, VersionWithStatus } from '@orbot/shared';
import { startTestApp, type TestApp } from './helpers.js';

describe('record history, as-of, diff and search', () => {
  let t: TestApp;
  let doc: DocumentView;
  let betweenV1andV2: string;

  beforeAll(async () => {
    t = await startTestApp();
    doc = (
      await t.agent
        .post('/api/documents')
        .send({
          kind: 'note',
          unitId: null,
          title: 'Engineers Field Manual',
          markdown: '# Branching\nUse feature branches.\n',
        })
        .expect(201)
    ).body;
    await new Promise((r) => setTimeout(r, 20));
    betweenV1andV2 = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    await t.agent
      .post(`/api/documents/${doc.id}/versions`)
      .send({
        markdown: '# Branching\nUse orbot/task-N branches.\n',
        reason: 'Lesson from task #7 handover',
        expectedVersion: 1,
      })
      .expect(201);
    await t.agent
      .post(`/api/documents/${doc.id}/versions`)
      .send({
        markdown: '# Branching\nUse orbot/task-N branches.\n\n# Tests\nWarm the cache first.\n',
        reason: 'Added tests section',
        expectedVersion: 2,
      })
      .expect(201);
  });
  afterAll(() => t.close());

  it('keeps every version with who, when, why and a link forward', async () => {
    const h: VersionWithStatus[] = (await t.agent.get(`/api/record/${doc.id}/history`).expect(200))
      .body;
    expect(h.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(h[0]!.superseded).toMatchObject({
      supersededByVersion: 2,
      supersededBy: 'commander:commander',
      reason: 'Lesson from task #7 handover',
    });
    expect(h[1]!.superseded).toMatchObject({
      supersededByVersion: 3,
      reason: 'Added tests section',
    });
    expect(h[2]!.superseded).toBeNull();
  });

  it('shows the document as it stood at a past moment', async () => {
    const r = (
      await t.agent.get(`/api/record/${doc.id}/as-of`).query({ at: betweenV1andV2 }).expect(200)
    ).body;
    expect(r.version.version).toBe(1);
    expect(r.version.body.markdown).toContain('Use feature branches.');
    const before = (
      await t.agent
        .get(`/api/record/${doc.id}/as-of`)
        .query({ at: '2000-01-01T00:00:00Z' })
        .expect(200)
    ).body;
    expect(before.version).toBeNull();
  });

  it('diffs two versions line by line', async () => {
    const d: VersionDiff = (
      await t.agent.get(`/api/record/${doc.id}/diff`).query({ from: 1, to: 3 }).expect(200)
    ).body;
    expect(d.lines).toContainEqual(
      expect.objectContaining({ kind: 'removed', text: 'Use feature branches.' }),
    );
    expect(d.lines).toContainEqual(
      expect.objectContaining({ kind: 'added', text: 'Use orbot/task-N branches.' }),
    );
    expect(d.lines).toContainEqual(expect.objectContaining({ kind: 'added', text: '# Tests' }));
  });

  it('searches the active tier by default and the archive on demand', async () => {
    const active: SearchHit[] = (
      await t.agent.get('/api/record/search').query({ q: 'feature branches' }).expect(200)
    ).body;
    expect(active.filter((h) => h.entityId === doc.id)).toHaveLength(0);

    const archived: SearchHit[] = (
      await t.agent
        .get('/api/record/search')
        .query({ q: 'feature branches', scope: 'archive' })
        .expect(200)
    ).body;
    expect(archived).toContainEqual(
      expect.objectContaining({ entityId: doc.id, version: 1, archived: true }),
    );

    const current: SearchHit[] = (
      await t.agent.get('/api/record/search').query({ q: 'warm cache' }).expect(200)
    ).body;
    expect(current).toContainEqual(
      expect.objectContaining({ entityId: doc.id, version: 3, archived: false }),
    );
  });

  it('refuses a rewrite based on a stale version, with a plain-language error', async () => {
    const r = await t.agent
      .post(`/api/documents/${doc.id}/versions`)
      .send({ markdown: 'stale', reason: 'oops', expectedVersion: 1 })
      .expect(409);
    expect(r.body.error.message).toMatch(/has changed since you opened it/);
    expect(r.body.error.action).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/at \w+ \(|\.ts:\d+/); // no stack trace
  });

  it('rejects invalid input with field-level issues, not a stack trace', async () => {
    const r = await t.agent.post('/api/documents').send({ kind: 'nonsense' }).expect(400);
    expect(r.body.error.code).toBe('invalid-input');
    expect(r.body.error.issues.length).toBeGreaterThan(0);
  });

  it('requires sign-in', async () => {
    const { default: request } = await import('supertest');
    const r = await request(t.app.getHttpServer()).get(`/api/record/${doc.id}/history`).expect(401);
    expect(r.body.error.action).toBe('Sign in to continue.');
  });
});
