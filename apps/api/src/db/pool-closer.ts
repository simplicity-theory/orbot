import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import { RECORD_POOL } from './database.js';

@Injectable()
export class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(RECORD_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
