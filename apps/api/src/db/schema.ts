import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  integer,
  jsonb,
  pgTable,
  pgView,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mapping of the record tables. The DDL itself lives in
 * `migrations/record/*.sql` (hand-written, because triggers, grants and
 * generated columns are the point). Keep the two in step.
 */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

const versionColumns = {
  id: uuid('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  version: integer('version').notNull(),
  unitId: uuid('unit_id'),
  title: text('title').notNull(),
  body: jsonb('body').notNull(),
  bodyText: text('body_text').notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  search: tsvector('search').generatedAlwaysAs(sql`search`),
};

export const recordVersion = pgTable('record_version', versionColumns);

export const recordSupersession = pgTable('record_supersession', {
  entityId: uuid('entity_id').notNull(),
  version: integer('version').notNull(),
  supersededByVersion: integer('superseded_by_version').notNull(),
  supersededAt: ts('superseded_at').notNull().defaultNow(),
  supersededBy: text('superseded_by').notNull(),
  reason: text('reason').notNull(),
});

export const recordEvent = pgTable('record_event', {
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
  id: uuid('id').notNull(),
  kind: text('kind').notNull(),
  unitId: uuid('unit_id'),
  botId: uuid('bot_id'),
  taskId: uuid('task_id'),
  operationId: uuid('operation_id'),
  missionId: uuid('mission_id'),
  actor: text('actor').notNull(),
  body: jsonb('body').notNull(),
  bodyText: text('body_text').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  search: tsvector('search').generatedAlwaysAs(sql`search`),
});

export const recordActive = pgView('record_active', versionColumns).existing();

export const recordArchive = pgView('record_archive', {
  ...versionColumns,
  supersededByVersion: integer('superseded_by_version').notNull(),
  supersededAt: ts('superseded_at').notNull(),
  supersededBy: text('superseded_by').notNull(),
  supersededReason: text('superseded_reason').notNull(),
}).existing();
