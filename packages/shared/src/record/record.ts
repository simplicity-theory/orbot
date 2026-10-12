import { z } from 'zod';
import { EntityType, Id } from '../domain/entities.js';

/** One immutable version of a versioned entity. */
export const RecordVersion = z.object({
  id: Id,
  entityType: EntityType,
  entityId: Id,
  version: z.number().int().positive(),
  unitId: Id.nullable(),
  body: z.unknown(),
  actor: z.string(),
  reason: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type RecordVersion<B = unknown> = Omit<z.infer<typeof RecordVersion>, 'body'> & { body: B };

/** The append-only stamp written when a version is replaced. */
export const Supersession = z.object({
  entityId: Id,
  version: z.number().int().positive(),
  supersededByVersion: z.number().int().positive(),
  supersededAt: z.iso.datetime({ offset: true }),
  supersededBy: z.string(),
  reason: z.string(),
});
export type Supersession = z.infer<typeof Supersession>;

/** A version together with its supersession stamp, if it has been replaced. */
export type VersionWithStatus<B = unknown> = RecordVersion<B> & {
  superseded: Supersession | null;
};

export const DiffLine = z.object({
  kind: z.enum(['same', 'added', 'removed']),
  text: z.string(),
  leftNo: z.number().int().nullable(),
  rightNo: z.number().int().nullable(),
});
export type DiffLine = z.infer<typeof DiffLine>;

export interface VersionDiff {
  entityId: string;
  from: number;
  to: number;
  lines: DiffLine[];
}

export const SearchScope = z.enum(['active', 'archive', 'all']);
export type SearchScope = z.infer<typeof SearchScope>;

export const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  scope: SearchScope.default('active'),
  types: z.array(z.string()).optional(),
  unitId: Id.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export interface SearchHit {
  source: 'version' | 'event';
  /** Entity type for versions, event kind for events. */
  type: string;
  id: string;
  entityId: string | null;
  version: number | null;
  archived: boolean;
  unitId: string | null;
  title: string;
  snippet: string;
  createdAt: string;
  rank: number;
}
