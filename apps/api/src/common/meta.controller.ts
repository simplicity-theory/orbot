import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type pg from 'pg';
import type { MetaView } from '@orbot/shared';
import { Public } from '../auth/auth.guard.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { RECORD_POOL } from '../db/database.js';
import { RuntimeRegistry } from '../runtime/runtime.registry.js';
import { SECRETS_POOL } from '../secrets/secrets.service.js';

export const ORBOT_VERSION = '0.1.0';

export interface HealthView {
  ok: boolean;
  /** The record database answers. */
  record: 'ok' | 'down';
  /** The secrets database answers. */
  secrets: 'ok' | 'down';
  version: string;
}

@Controller()
export class MetaController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RECORD_POOL) private readonly recordPool: pg.Pool,
    @Inject(SECRETS_POOL) private readonly secretsPool: pg.Pool,
    private readonly runtimes: RuntimeRegistry,
  ) {}

  @Public()
  @Get('meta')
  meta(): MetaView {
    return {
      productName: this.config.productName,
      runtime: this.config.defaultRuntime,
      runtimes: this.runtimes.kinds(),
      claudeModel: this.config.claudeModel,
    };
  }

  /**
   * For the container's health check and the reverse proxy: both databases must answer.
   * Says only up or down, never why (a connection error names hosts and users).
   */
  @Public()
  @Get('health')
  async health(): Promise<HealthView> {
    const [record, secrets] = await Promise.all([
      answers(this.recordPool),
      answers(this.secretsPool),
    ]);
    const view: HealthView = {
      ok: record && secrets,
      record: up(record),
      secrets: up(secrets),
      version: ORBOT_VERSION,
    };
    if (!view.ok) throw new HttpException(view, HttpStatus.SERVICE_UNAVAILABLE);
    return view;
  }
}

const up = (ok: boolean): 'ok' | 'down' => (ok ? 'ok' : 'down');

async function answers(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
