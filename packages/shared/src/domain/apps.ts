import { z } from 'zod';

/** Values a setting may take go into a shell environment file: no quotes, no `$`, no newlines. */
export const APP_SETTING_VALUE = /^[A-Za-z0-9 ._/:@+=,-]*$/;

const AppSetting = z.object({
  /** The environment variable the scripts read. */
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(['string', 'integer', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]),
  min: z.number().optional(),
  max: z.number().optional(),
  help: z.string().optional(),
});
export type AppSetting = z.infer<typeof AppSetting>;

const AppSecret = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: z.string().min(1),
  /** ORBOT generates it (random) and keeps it in the secrets store. Otherwise a credential is chosen. */
  generate: z.boolean().default(false),
  optional: z.boolean().default(false),
  help: z.string().optional(),
});
export type AppSecret = z.infer<typeof AppSecret>;

/**
 * An app ORBOT can install on a server: `deploy/apps/<id>/app.json` next to its install.sh,
 * status.sh and uninstall.sh.
 */
export const AppManifest = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().min(1),
  summary: z.string().min(1),
  requires: z.array(z.string()).default([]),
  settings: z.array(AppSetting).default([]),
  secrets: z.array(AppSecret).default([]),
  /** A depot item it adds once installed. `{host}` and `{SETTING}` are filled in. */
  provides: z
    .object({
      kind: z.literal('model'),
      protocol: z.enum(['openai']),
      baseUrl: z.string().min(1),
      model: z.string().min(1),
      /** The secret that is its API key. */
      apiKey: z.string().nullable().default(null),
      /** The setting holding its context window. */
      contextWindow: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** How long an install may take before ORBOT calls it failed. */
  installMinutes: z.number().int().positive().default(60),
});
export type AppManifest = z.infer<typeof AppManifest>;
