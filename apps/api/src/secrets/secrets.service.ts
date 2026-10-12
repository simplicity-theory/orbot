import { BadRequestException, Inject, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { createPool } from '../db/database.js';
import { RedactionService } from '../redaction/redaction.service.js';
import { RecordService } from '../record/record.service.js';
import { keyId, open, seal } from './crypto.js';

export const SECRETS_POOL = Symbol('SECRETS_POOL');

export interface SecretInfo {
  name: string;
  createdAt: string;
  rotatedAt: string | null;
  revoked: boolean;
}

export const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{1,99}$/;

/**
 * The secrets store: a separate database reachable only with the `orbot_secrets`
 * role, values encrypted at rest. This service is the only code that can read a
 * value, and it never returns one through the API. Everything else refers to
 * secrets by name.
 */
@Injectable()
export class SecretsService implements OnModuleInit, OnModuleDestroy {
  private readonly key: Buffer;
  private retiredCount = 0;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(SECRETS_POOL) private readonly pool: pg.Pool,
    private readonly redaction: RedactionService,
    private readonly record: RecordService,
  ) {
    this.key = config.secretsKey;
  }

  /** Load every live secret into the redaction layer so its value can never leak. */
  async onModuleInit(): Promise<void> {
    const rows = await this.pool.query<SecretRow>(
      'SELECT name, ciphertext, iv, auth_tag, key_id FROM secret WHERE revoked_at IS NULL',
    );
    const currentKey = keyId(this.key);
    for (const r of rows.rows) {
      if (r.key_id !== currentKey) {
        throw new Error(
          `Secret "${r.name}" was encrypted with a different ORBOT_SECRETS_KEY. Restore the original key to start.`,
        );
      }
      this.redaction.registerSecret(r.name, this.decrypt(r));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /** Store or rotate a secret. Recorded in the record by name only. */
  async store(name: string, value: string, actor: string): Promise<SecretInfo> {
    if (!SECRET_NAME.test(name)) {
      throw new BadRequestException(
        'Secret names use lowercase letters, digits, dots, dashes and underscores (2–100 characters).',
      );
    }
    if (value.length < 4) throw new BadRequestException('A secret value must be at least 4 characters.');
    // Register before anything else so the value is masked even in errors from the steps below.
    const previous = await this.tryReveal(name);
    this.redaction.registerSecret(name, value);
    if (previous !== null && previous !== value) {
      // Keep masking the old value too: it may still be in flight somewhere.
      this.redaction.registerSecret(`${name}#retired-${++this.retiredCount}`, previous);
    }
    const s = seal(this.key, name, value);
    const { rows } = await this.pool.query<InfoRow>(
      `INSERT INTO secret (name, ciphertext, iv, auth_tag, key_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
             key_id = EXCLUDED.key_id, rotated_at = now(), revoked_at = NULL
       RETURNING name, created_at, rotated_at, revoked_at`,
      [name, s.ciphertext, s.iv, s.authTag, s.keyId],
    );
    await this.record.event('secret.stored', { secretName: name }, {}, actor);
    return toInfo(rows[0]!);
  }

  async revoke(name: string, actor: string): Promise<SecretInfo> {
    const { rows } = await this.pool.query<InfoRow>(
      `UPDATE secret SET revoked_at = now() WHERE name = $1 AND revoked_at IS NULL
       RETURNING name, created_at, rotated_at, revoked_at`,
      [name],
    );
    if (!rows[0]) throw new NotFoundException(`No live secret named "${name}".`);
    await this.record.event('secret.revoked', { secretName: name }, {}, actor);
    // The value stays registered with the redactor: revoking must not make it printable.
    return toInfo(rows[0]);
  }

  async list(): Promise<SecretInfo[]> {
    const { rows } = await this.pool.query<InfoRow>(
      'SELECT name, created_at, rotated_at, revoked_at FROM secret ORDER BY name',
    );
    return rows.map(toInfo);
  }

  async exists(name: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM secret WHERE name = $1 AND revoked_at IS NULL', [name]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Decrypt a value for immediate use. Internal only: callers must pass it
   * straight to the operation that needs it and record the use by name.
   */
  async reveal(name: string): Promise<string> {
    const v = await this.tryReveal(name);
    if (v === null) throw new NotFoundException(`No live secret named "${name}". Connect it in the Supply Depot.`);
    return v;
  }

  private async tryReveal(name: string): Promise<string | null> {
    const { rows } = await this.pool.query<SecretRow>(
      'SELECT name, ciphertext, iv, auth_tag, key_id FROM secret WHERE name = $1 AND revoked_at IS NULL',
      [name],
    );
    return rows[0] ? this.decrypt(rows[0]) : null;
  }

  private decrypt(r: SecretRow): string {
    return open(this.key, r.name, { ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag });
  }
}

interface SecretRow {
  name: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_id: string;
}

interface InfoRow {
  name: string;
  created_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

function toInfo(r: InfoRow): SecretInfo {
  return {
    name: r.name,
    createdAt: r.created_at.toISOString(),
    rotatedAt: r.rotated_at?.toISOString() ?? null,
    revoked: r.revoked_at !== null,
  };
}

export function createSecretsPool(config: AppConfig): pg.Pool {
  return createPool(config.secretsDb, 4);
}
