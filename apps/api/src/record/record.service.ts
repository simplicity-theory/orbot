import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { diffLines } from 'diff';
import {
  detectorsOf,
  ENTITY_BODY_SCHEMAS,
  RecordEventBodies,
  type DiffLine,
  type EntityBodyMap,
  type EntityInputMap,
  type EntityType,
  type EventQuery,
  type RecordEvent,
  type RecordEventBody,
  type RecordEventKind,
  type RecordEventRefs,
  type RecordVersion,
  type SearchHit,
  type SearchQuery,
  type Supersession,
  type VersionDiff,
  type VersionWithStatus,
} from '@orbot/shared';
import { RECORD_DB, type RecordDb } from '../db/database.js';
import { recordActive, recordEvent, recordSupersession, recordVersion } from '../db/schema.js';
import { RedactionService } from '../redaction/redaction.service.js';
import { RecordBus, type RecordNotification } from './record-bus.js';
import { diffableText, searchableText, titleOf } from './text.js';

export interface WriteContext {
  actor: string;
  reason: string;
}

type Tx = Parameters<Parameters<RecordDb['transaction']>[0]>[0];
type Executor = RecordDb | Tx;

const UNIQUE_VIOLATION = '23505';
const MAX_RETRIES = 4;

const iso = (s: string | Date) => new Date(s).toISOString();

type VersionRow = typeof recordVersion.$inferSelect;
type EventRow = typeof recordEvent.$inferSelect;

function toVersion<B>(r: Omit<VersionRow, 'search'>): RecordVersion<B> {
  return {
    id: r.id,
    entityType: r.entityType as EntityType,
    entityId: r.entityId,
    version: r.version,
    unitId: r.unitId,
    body: r.body as B,
    actor: r.actor,
    reason: r.reason,
    createdAt: iso(r.createdAt),
  };
}

function toEvent(r: Omit<EventRow, 'search'>): RecordEvent {
  return {
    id: r.id,
    seq: Number(r.seq),
    kind: r.kind as RecordEventKind,
    unitId: r.unitId,
    botId: r.botId,
    taskId: r.taskId,
    operationId: r.operationId,
    missionId: r.missionId,
    actor: r.actor,
    body: r.body as RecordEvent['body'],
    createdAt: iso(r.createdAt),
  };
}

/** Columns to select from version tables (everything except the tsvector). */
const versionCols = {
  id: recordVersion.id,
  entityType: recordVersion.entityType,
  entityId: recordVersion.entityId,
  version: recordVersion.version,
  unitId: recordVersion.unitId,
  title: recordVersion.title,
  body: recordVersion.body,
  bodyText: recordVersion.bodyText,
  actor: recordVersion.actor,
  reason: recordVersion.reason,
  createdAt: recordVersion.createdAt,
};
const activeCols = {
  id: recordActive.id,
  entityType: recordActive.entityType,
  entityId: recordActive.entityId,
  version: recordActive.version,
  unitId: recordActive.unitId,
  title: recordActive.title,
  body: recordActive.body,
  bodyText: recordActive.bodyText,
  actor: recordActive.actor,
  reason: recordActive.reason,
  createdAt: recordActive.createdAt,
};
const eventCols = {
  seq: recordEvent.seq,
  id: recordEvent.id,
  kind: recordEvent.kind,
  unitId: recordEvent.unitId,
  botId: recordEvent.botId,
  taskId: recordEvent.taskId,
  operationId: recordEvent.operationId,
  missionId: recordEvent.missionId,
  actor: recordEvent.actor,
  body: recordEvent.body,
  bodyText: recordEvent.bodyText,
  createdAt: recordEvent.createdAt,
};

/**
 * A unit of work against the record. All writes in one `RecordService.transaction`
 * commit together; notifications go out only after commit.
 */
export class RecordWriter {
  readonly pending: RecordNotification[] = [];

  constructor(
    private readonly tx: Tx,
    private readonly redaction: RedactionService,
  ) {}

  /** Create a new entity (version 1). */
  async create<T extends EntityType>(
    type: T,
    body: EntityInputMap[T],
    ctx: WriteContext,
    id: string = randomUUID(),
  ): Promise<RecordVersion<EntityBodyMap[T]>> {
    return this.insertVersion(type, id, 1, body, ctx);
  }

  /**
   * Write a new version of an entity. `change` receives the current body and
   * returns the next one. Returns the current version unchanged if nothing changed.
   * The previous version is stamped as superseded (an insert, never an update).
   */
  async revise<T extends EntityType>(
    type: T,
    id: string,
    change: (current: EntityBodyMap[T]) => EntityBodyMap[T],
    ctx: WriteContext & { expectedVersion?: number },
  ): Promise<RecordVersion<EntityBodyMap[T]>> {
    const current = await getActive<T>(this.tx, type, id);
    if (!current) throw new NotFoundException(`No ${type} with id ${id}.`);
    if (ctx.expectedVersion !== undefined && ctx.expectedVersion !== current.version) {
      throw new ConflictException(
        `This ${type} has changed since you opened it (you had version ${ctx.expectedVersion}, it is now at ${current.version}). Reload and try again.`,
      );
    }
    const next = change(structuredClone(current.body));
    if (JSON.stringify(next) === JSON.stringify(current.body)) return current;
    const created = await this.insertVersion(type, id, current.version + 1, next, ctx);
    const stamp = this.redaction.clean({ actor: ctx.actor, reason: ctx.reason });
    await this.tx.insert(recordSupersession).values({
      entityId: id,
      version: current.version,
      supersededByVersion: created.version,
      supersededBy: stamp.actor,
      reason: stamp.reason,
    });
    return created;
  }

  /** Read current state inside this transaction (sees this transaction's own writes). */
  getActive<T extends EntityType>(type: T, id: string) {
    return getActive(this.tx, type, id);
  }

  listActive<T extends EntityType>(type: T, filter: ActiveFilter<T> = {}) {
    return listActive(this.tx, type, filter);
  }

  /** Append an immutable event. */
  async event<K extends RecordEventKind>(
    kind: K,
    body: RecordEventBody<K>,
    refs: RecordEventRefs,
    actor: string,
  ): Promise<RecordEvent<K>> {
    const red = this.redaction.redactDeep(body);
    const cleanActor = this.redaction.clean(actor);
    const parsed = RecordEventBodies[kind].parse(red.value) as RecordEventBody<K>;
    const [row] = await this.tx
      .insert(recordEvent)
      .values({
        id: randomUUID(),
        kind,
        unitId: refs.unitId ?? null,
        botId: refs.botId ?? null,
        taskId: refs.taskId ?? null,
        operationId: refs.operationId ?? null,
        missionId: refs.missionId ?? null,
        actor: cleanActor,
        body: parsed,
        bodyText: searchableText(parsed),
      })
      .returning(eventCols);
    const ev = toEvent(row!) as RecordEvent<K>;
    this.pending.push({ type: 'event', event: ev });
    if (red.findings.length && kind !== 'redaction.applied') {
      await this.noteRedaction(red.findings, `event:${kind}`, refs, cleanActor);
    }
    return ev;
  }

  private async insertVersion<T extends EntityType>(
    type: T,
    id: string,
    version: number,
    body: EntityInputMap[T],
    ctx: WriteContext,
  ): Promise<RecordVersion<EntityBodyMap[T]>> {
    const red = this.redaction.redactDeep(body);
    const meta = this.redaction.clean({ actor: ctx.actor, reason: ctx.reason });
    const parsed = ENTITY_BODY_SCHEMAS[type].parse(red.value) as EntityBodyMap[T];
    const unitId = unitIdOf(type, id, parsed);
    const [row] = await this.tx
      .insert(recordVersion)
      .values({
        id: randomUUID(),
        entityType: type,
        entityId: id,
        version,
        unitId,
        title: titleOf(type, parsed),
        body: parsed,
        bodyText: searchableText(parsed),
        actor: meta.actor,
        reason: meta.reason,
      })
      .returning(versionCols);
    const v = toVersion<EntityBodyMap[T]>(row!);
    this.pending.push({ type: 'version', version: v });
    if (red.findings.length) {
      await this.noteRedaction(red.findings, `${type}:${id}`, { unitId }, meta.actor);
    }
    return v;
  }

  private async noteRedaction(
    findings: { detector: string }[],
    where: string,
    refs: RecordEventRefs,
    actor: string,
  ) {
    await this.event(
      'redaction.applied',
      { detectors: detectorsOf(findings), where, count: findings.length },
      refs,
      actor,
    );
  }
}

function unitIdOf(type: EntityType, id: string, body: unknown): string | null {
  if (type === 'unit') return id;
  const b = body as { unitId?: string | null };
  return b.unitId ?? null;
}

async function getActive<T extends EntityType>(
  ex: Executor,
  type: T,
  id: string,
): Promise<RecordVersion<EntityBodyMap[T]> | null> {
  const [row] = await ex
    .select(activeCols)
    .from(recordActive)
    .where(and(eq(recordActive.entityId, id), eq(recordActive.entityType, type)));
  return row ? toVersion<EntityBodyMap[T]>(row) : null;
}

export interface ActiveFilter<T extends EntityType> {
  unitId?: string;
  bodyContains?: Partial<EntityBodyMap[T]>;
}

async function listActive<T extends EntityType>(
  ex: Executor,
  type: T,
  filter: ActiveFilter<T>,
): Promise<RecordVersion<EntityBodyMap[T]>[]> {
  const where: SQL[] = [eq(recordActive.entityType, type)];
  if (filter.unitId) where.push(eq(recordActive.unitId, filter.unitId));
  if (filter.bodyContains) {
    where.push(sql`${recordActive.body} @> ${JSON.stringify(filter.bodyContains)}::jsonb`);
  }
  const rows = await ex
    .select(activeCols)
    .from(recordActive)
    .where(and(...where))
    .orderBy(asc(recordActive.title));
  return rows.map((r) => toVersion<EntityBodyMap[T]>(r));
}

/**
 * The permanent record. Writes are inserts only: new versions, supersession
 * stamps and events. Every write passes through the redaction layer first.
 */
@Injectable()
export class RecordService {
  constructor(
    @Inject(RECORD_DB) private readonly db: RecordDb,
    private readonly redaction: RedactionService,
    private readonly bus: RecordBus,
  ) {}

  /**
   * Run `fn` in one transaction. Retried automatically if a concurrent writer
   * claimed the same version number, so `fn` must only touch the database.
   */
  async transaction<R>(fn: (w: RecordWriter) => Promise<R>): Promise<R> {
    for (let attempt = 1; ; attempt++) {
      let writer: RecordWriter | undefined;
      try {
        const result = await this.db.transaction(async (tx) => {
          writer = new RecordWriter(tx, this.redaction);
          return fn(writer);
        });
        writer!.pending.forEach((n) => this.bus.publish(n));
        return result;
      } catch (err) {
        if (attempt < MAX_RETRIES && pgCode(err) === UNIQUE_VIOLATION) continue;
        throw err;
      }
    }
  }

  create<T extends EntityType>(type: T, body: EntityInputMap[T], ctx: WriteContext, id?: string) {
    return this.transaction((w) => w.create(type, body, ctx, id));
  }

  revise<T extends EntityType>(
    type: T,
    id: string,
    change: (current: EntityBodyMap[T]) => EntityBodyMap[T],
    ctx: WriteContext & { expectedVersion?: number },
  ) {
    return this.transaction((w) => w.revise(type, id, change, ctx));
  }

  event<K extends RecordEventKind>(
    kind: K,
    body: RecordEventBody<K>,
    refs: RecordEventRefs,
    actor: string,
  ) {
    return this.transaction((w) => w.event(kind, body, refs, actor));
  }

  async nextTaskNumber(): Promise<number> {
    const r = await this.db.execute<{ n: string }>(sql`SELECT nextval('task_number_seq') AS n`);
    return Number(r.rows[0]!.n);
  }

  // ---------- Reading ----------

  getActive<T extends EntityType>(type: T, id: string) {
    return getActive(this.db, type, id);
  }

  async requireActive<T extends EntityType>(
    type: T,
    id: string,
  ): Promise<RecordVersion<EntityBodyMap[T]>> {
    const v = await this.getActive(type, id);
    if (!v) throw new NotFoundException(`No ${type} with id ${id}.`);
    return v;
  }

  /** Active versions of a type, optionally filtered by unit and/or JSON containment on the body. */
  listActive<T extends EntityType>(type: T, filter: ActiveFilter<T> = {}) {
    return listActive(this.db, type, filter);
  }

  /** Every version of an entity, oldest first, each with its supersession stamp. */
  async history(entityId: string): Promise<VersionWithStatus[]> {
    const rows = await this.db
      .select({ v: versionCols, s: recordSupersession })
      .from(recordVersion)
      .leftJoin(
        recordSupersession,
        and(
          eq(recordSupersession.entityId, recordVersion.entityId),
          eq(recordSupersession.version, recordVersion.version),
        ),
      )
      .where(eq(recordVersion.entityId, entityId))
      .orderBy(asc(recordVersion.version));
    if (!rows.length) throw new NotFoundException(`Nothing in the record with id ${entityId}.`);
    return rows.map(({ v, s }) => ({
      ...toVersion(v),
      superseded: s ? toSupersession(s) : null,
    }));
  }

  async getVersion(entityId: string, version: number): Promise<VersionWithStatus> {
    const all = await this.history(entityId);
    const v = all.find((x) => x.version === version);
    if (!v) throw new NotFoundException(`Version ${version} of ${entityId} does not exist.`);
    return v;
  }

  /** The entity as it stood at a moment in time (null if it did not exist yet). */
  async asOf(entityId: string, at: string): Promise<VersionWithStatus | null> {
    const [row] = await this.db
      .select({ version: recordVersion.version })
      .from(recordVersion)
      .where(and(eq(recordVersion.entityId, entityId), lte(recordVersion.createdAt, iso(at))))
      .orderBy(desc(recordVersion.version))
      .limit(1);
    return row ? this.getVersion(entityId, row.version) : null;
  }

  async diff(entityId: string, from: number, to: number): Promise<VersionDiff> {
    const all = await this.history(entityId);
    const a = all.find((x) => x.version === from);
    const b = all.find((x) => x.version === to);
    if (!a || !b)
      throw new NotFoundException(
        `Cannot diff ${entityId}: version ${!a ? from : to} does not exist.`,
      );
    return {
      entityId,
      from,
      to,
      lines: lineDiff(diffableText(a.entityType, a.body), diffableText(b.entityType, b.body)),
    };
  }

  /**
   * Events in record order. `latest` returns the most recent `limit` (still oldest first);
   * `from`/`to` bound the timestamp (inclusive/exclusive).
   */
  async listEvents(
    q: EventQuery,
    opts: { latest?: boolean; from?: string; to?: string; missionId?: string } = {},
  ): Promise<RecordEvent[]> {
    const where: SQL[] = [];
    if (q.unitId) where.push(eq(recordEvent.unitId, q.unitId));
    if (q.botId) where.push(eq(recordEvent.botId, q.botId));
    if (q.taskId) where.push(eq(recordEvent.taskId, q.taskId));
    if (q.operationId) where.push(eq(recordEvent.operationId, q.operationId));
    if (opts.missionId) where.push(eq(recordEvent.missionId, opts.missionId));
    if (q.kinds?.length) where.push(inArray(recordEvent.kind, q.kinds));
    if (q.afterSeq !== undefined) where.push(gt(recordEvent.seq, q.afterSeq));
    if (opts.from) where.push(sql`${recordEvent.createdAt} >= ${opts.from}`);
    if (opts.to) where.push(sql`${recordEvent.createdAt} < ${opts.to}`);
    const rows = await this.db
      .select(eventCols)
      .from(recordEvent)
      .where(where.length ? and(...where) : undefined)
      .orderBy(opts.latest ? desc(recordEvent.seq) : asc(recordEvent.seq))
      .limit(q.limit);
    const events = rows.map(toEvent);
    return opts.latest ? events.reverse() : events;
  }

  async getEvent(id: string): Promise<RecordEvent | null> {
    const [row] = await this.db.select(eventCols).from(recordEvent).where(eq(recordEvent.id, id));
    return row ? toEvent(row) : null;
  }

  /** Events of the given kinds whose body contains `body` (JSON containment), oldest first. */
  async findEvents(
    kinds: RecordEventKind[],
    body: Record<string, unknown>,
    opts: { limit?: number; latest?: boolean } = {},
  ): Promise<RecordEvent[]> {
    const rows = await this.db
      .select(eventCols)
      .from(recordEvent)
      .where(
        and(
          inArray(recordEvent.kind, kinds),
          sql`${recordEvent.body} @> ${JSON.stringify(body)}::jsonb`,
        ),
      )
      .orderBy(opts.latest ? desc(recordEvent.seq) : asc(recordEvent.seq))
      .limit(opts.limit ?? 1000);
    const events = rows.map(toEvent);
    return opts.latest ? events.reverse() : events;
  }

  /** Every version of every entity that refers to `id` in its body (e.g. a task's handover). */
  async versionsReferencing(field: string, id: string): Promise<RecordVersion[]> {
    const rows = await this.db
      .select(versionCols)
      .from(recordVersion)
      .where(sql`${recordVersion.body} @> ${JSON.stringify({ [field]: id })}::jsonb`)
      .orderBy(asc(recordVersion.createdAt));
    return rows.map((r) => toVersion(r));
  }

  /**
   * Full-text search. `active` (default) searches current versions and events;
   * `archive` searches superseded versions only; `all` searches everything.
   */
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const query = sql`websearch_to_tsquery('english', ${q.q})`;
    // A retired entity (its current body says `retired: true`) belongs to the archive tier.
    const retired = sql`coalesce((v.body->>'retired')::boolean, false)`;
    const superseded = sql`EXISTS (SELECT 1 FROM record_supersession s WHERE s.entity_id = v.entity_id AND s.version = v.version)`;
    const versionSource =
      q.scope === 'active'
        ? sql`(SELECT v.* FROM record_active v WHERE NOT ${retired})`
        : q.scope === 'archive'
          ? sql`(SELECT v.* FROM record_version v WHERE ${superseded} OR ${retired})`
          : sql`record_version`;

    const vWhere: SQL[] = [sql`v.search @@ ${query}`];
    const eWhere: SQL[] = [sql`e.search @@ ${query}`];
    if (q.unitId) {
      vWhere.push(sql`v.unit_id = ${q.unitId}`);
      eWhere.push(sql`e.unit_id = ${q.unitId}`);
    }
    if (q.from) {
      vWhere.push(sql`v.created_at >= ${q.from}`);
      eWhere.push(sql`e.created_at >= ${q.from}`);
    }
    if (q.to) {
      vWhere.push(sql`v.created_at <= ${q.to}`);
      eWhere.push(sql`e.created_at <= ${q.to}`);
    }
    if (q.types?.length) {
      const types = sql.join(
        q.types.map((t) => sql`${t}`),
        sql`, `,
      );
      vWhere.push(sql`v.entity_type IN (${types})`);
      eWhere.push(sql`e.kind IN (${types})`);
    }

    const versionsSql = sql`
      SELECT 'version' AS source, v.entity_type AS type, v.id::text AS id, v.entity_id::text AS entity_id,
             v.version, (${superseded} OR ${retired}) AS archived,
             v.unit_id::text AS unit_id,
             CASE WHEN v.entity_type = 'task' THEN v.entity_id::text ELSE v.body->>'taskId' END AS task_id,
             CASE WHEN v.entity_type = 'bot' THEN v.entity_id::text ELSE v.body->>'botId' END AS bot_id,
             v.title,
             ts_headline('english', v.body_text, ${query}, 'MaxFragments=2,MaxWords=18,MinWords=6,StartSel=⟦,StopSel=⟧,FragmentDelimiter= … ') AS snippet,
             v.created_at, ts_rank(v.search, ${query}) AS rank
      FROM ${versionSource} v WHERE ${sql.join(vWhere, sql` AND `)}`;
    const eventsSql = sql`
      SELECT 'event' AS source, e.kind AS type, e.id::text AS id, NULL AS entity_id, NULL::int AS version,
             false AS archived, e.unit_id::text AS unit_id, e.task_id::text AS task_id, e.bot_id::text AS bot_id,
             e.kind AS title,
             ts_headline('english', e.body_text, ${query}, 'MaxFragments=2,MaxWords=18,MinWords=6,StartSel=⟦,StopSel=⟧,FragmentDelimiter= … ') AS snippet,
             e.created_at, ts_rank(e.search, ${query}) AS rank
      FROM record_event e WHERE ${sql.join(eWhere, sql` AND `)}`;

    const union = q.scope === 'archive' ? versionsSql : sql`${versionsSql} UNION ALL ${eventsSql}`;
    const r = await this.db.execute<{
      source: 'version' | 'event';
      type: string;
      id: string;
      entity_id: string | null;
      version: number | null;
      archived: boolean;
      unit_id: string | null;
      task_id: string | null;
      bot_id: string | null;
      title: string;
      snippet: string;
      created_at: string | Date;
      rank: number;
    }>(sql`SELECT * FROM (${union}) hits ORDER BY rank DESC, created_at DESC LIMIT ${q.limit}`);
    return r.rows.map((h) => ({
      source: h.source,
      type: h.type,
      id: h.id,
      entityId: h.entity_id,
      version: h.version,
      archived: h.archived,
      unitId: h.unit_id,
      taskId: h.task_id,
      botId: h.bot_id,
      title: h.title,
      snippet: h.snippet,
      createdAt: iso(h.created_at),
      rank: Number(h.rank),
    }));
  }
}

function toSupersession(s: typeof recordSupersession.$inferSelect): Supersession {
  return {
    entityId: s.entityId,
    version: s.version,
    supersededByVersion: s.supersededByVersion,
    supersededAt: iso(s.supersededAt),
    supersededBy: s.supersededBy,
    reason: s.reason,
  };
}

export function lineDiff(left: string, right: string): DiffLine[] {
  const out: DiffLine[] = [];
  let l = 1;
  let r = 1;
  for (const part of diffLines(left, right)) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (part.added) out.push({ kind: 'added', text, leftNo: null, rightNo: r++ });
      else if (part.removed) out.push({ kind: 'removed', text, leftNo: l++, rightNo: null });
      else out.push({ kind: 'same', text, leftNo: l++, rightNo: r++ });
    }
  }
  return out;
}

export function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
