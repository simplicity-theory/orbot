import { z } from 'zod';
import { DocumentKind, Id } from '../domain/entities.js';

/** Request bodies shared by the API (validation) and the web app (typing). */

export const CreateTaskRequest = z.object({
  unitId: Id,
  botId: Id.nullable().default(null),
  missionId: Id.nullable().default(null),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
  repoSupplyId: Id.nullable().default(null),
  credentialNames: z.array(z.string()).default([]),
  scenario: z.string().nullable().default(null),
  budgetLimitUnits: z.number().nonnegative().nullable().default(null),
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequest>;

export const ConnectRepositoryRequest = z.object({
  name: z.string().trim().min(1).max(100),
  /** Local path to a git repository, or a clone URL (without embedded credentials). */
  location: z.string().trim().min(1).max(1000),
  defaultBranch: z.string().trim().min(1).max(200).optional(),
});
export type ConnectRepositoryRequest = z.input<typeof ConnectRepositoryRequest>;

export const StoreCredentialRequest = z.object({
  name: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{1,99}$/, {
    message: 'Use lowercase letters, digits, dots, dashes and underscores.',
  }),
  /** Write-only. Never returned by any endpoint. */
  value: z.string().min(4).max(20_000),
});
export type StoreCredentialRequest = z.input<typeof StoreCredentialRequest>;

export const CreateDocumentRequest = z.object({
  kind: DocumentKind,
  unitId: Id.nullable(),
  title: z.string().trim().min(1).max(200),
  markdown: z.string().max(200_000),
});
export type CreateDocumentRequest = z.input<typeof CreateDocumentRequest>;

export const ReviseDocumentRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  markdown: z.string().max(200_000),
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});
export type ReviseDocumentRequest = z.input<typeof ReviseDocumentRequest>;
