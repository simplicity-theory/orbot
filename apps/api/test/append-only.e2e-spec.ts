import { RecordService } from '../src/record/record.service.js';
import { asRole, startTestApp, type TestApp } from './helpers.js';

const TABLES = [
  'record_version',
  'record_supersession',
  'record_event',
  'schema_migration',
] as const;

const STATEMENTS: Record<(typeof TABLES)[number], { update: string; delete: string }> = {
  record_version: {
    update: `UPDATE record_version SET reason = 'tampered'`,
    delete: 'DELETE FROM record_version',
  },
  record_supersession: {
    update: `UPDATE record_supersession SET reason = 'tampered'`,
    delete: 'DELETE FROM record_supersession',
  },
  record_event: {
    update: `UPDATE record_event SET actor = 'tampered'`,
    delete: 'DELETE FROM record_event',
  },
  schema_migration: {
    update: `UPDATE schema_migration SET name = 'tampered'`,
    delete: 'DELETE FROM schema_migration',
  },
};

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'no-error';
}

describe('the record is append-only', () => {
  let t: TestApp;
  let docId: string;

  beforeAll(async () => {
    t = await startTestApp();
    const record = t.app.get(RecordService);
    const doc = await record.create(
      'document',
      { kind: 'note', unitId: null, title: 'Original', markdown: 'v1', taskId: null, botId: null },
      { actor: 'system:test', reason: 'create' },
    );
    docId = doc.entityId;
    await record.revise('document', docId, (d) => ({ ...d, markdown: 'v2' }), {
      actor: 'system:test',
      reason: 'rewrite',
    });
    await record.event(
      'diary.entry',
      { category: 'note', text: 'something happened' },
      {},
      'system:test',
    );
  });
  afterAll(() => t.close());

  it('has rows in every record table to tamper with', async () => {
    await asRole(t.config.recordDb.owner, async (c) => {
      for (const table of TABLES) {
        const { rows } = await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        expect(Number(rows[0]!.n), table).toBeGreaterThan(0);
      }
    });
  });

  describe.each(TABLES)('%s', (table) => {
    it('rejects UPDATE, DELETE and TRUNCATE from the API role (no privilege)', async () => {
      await asRole(t.config.recordDb.app, async (c) => {
        expect(await errorCode(c.query(STATEMENTS[table].update))).toBe('42501');
        expect(await errorCode(c.query(STATEMENTS[table].delete))).toBe('42501');
        expect(await errorCode(c.query(`TRUNCATE ${table} CASCADE`))).toBe('42501');
      });
    });

    it('rejects UPDATE, DELETE and TRUNCATE even from the table owner (trigger)', async () => {
      await asRole(t.config.recordDb.owner, async (c) => {
        expect(await errorCode(c.query(STATEMENTS[table].update))).toBe('OR001');
        expect(await errorCode(c.query(STATEMENTS[table].delete))).toBe('OR001');
        expect(await errorCode(c.query(`TRUNCATE ${table} CASCADE`))).toBe('OR001');
      });
    });
  });

  it('kept the original version intact after a rewrite', async () => {
    const history = await t.app.get(RecordService).history(docId);
    expect(history.map((v) => (v.body as { markdown: string }).markdown)).toEqual(['v1', 'v2']);
    expect(history[0]!.superseded).toMatchObject({
      supersededByVersion: 2,
      supersededBy: 'system:test',
      reason: 'rewrite',
    });
    expect(history[1]!.superseded).toBeNull();
  });

  it('refuses a new version that skips the supersession stamp', async () => {
    const code = await asRole(t.config.recordDb.app, (c) =>
      errorCode(
        c.query(
          `INSERT INTO record_version (id, entity_type, entity_id, version, title, body, body_text, actor, reason)
           VALUES (gen_random_uuid(), 'document', $1, 3, 'sneaky', '{}', '', 'x', 'x')`,
          [docId],
        ),
      ),
    );
    expect(code).toBe('P0001');
  });

  it('refuses a second version 2 (no forks in history)', async () => {
    const code = await asRole(t.config.recordDb.app, (c) =>
      errorCode(
        c.query(
          `INSERT INTO record_version (id, entity_type, entity_id, version, title, body, body_text, actor, reason)
           VALUES (gen_random_uuid(), 'document', $1, 2, 'fork', '{}', '', 'x', 'x')`,
          [docId],
        ),
      ),
    );
    expect(code).toBe('23505');
  });

  it('the API role cannot reach the secrets database', async () => {
    const code = await errorCode(
      asRole({ ...t.config.recordDb.app, database: t.config.secretsDb.database }, async () => 0),
    );
    expect(code).toBe('42501');
  });

  it('offers no way to delete through the API', async () => {
    await t.agent.delete(`/api/documents/${docId}`).expect(404);
  });
});
