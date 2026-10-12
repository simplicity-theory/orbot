import { Injectable } from '@nestjs/common';
import { RedactingLogger } from '../redaction/redacting-logger.js';

/**
 * Runs event-driven work (curation, document mirroring, dispatch) off the request
 * path. Jobs with the same key run one at a time, in order, so a unit's Overseer
 * never acts on a half-applied change. `idle()` resolves once nothing is pending.
 */
@Injectable()
export class Background {
  private readonly chains = new Map<string, Promise<void>>();
  private pending = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly logger: RedactingLogger) {}

  run(key: string, label: string, job: () => Promise<unknown>): void {
    this.pending++;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(job)
      .then(
        () => undefined,
        (err: unknown) => {
          this.logger.error(
            err instanceof Error ? err : new Error(String(err)),
            `background:${label}`,
          );
        },
      )
      .finally(() => {
        this.pending--;
        if (this.chains.get(key) === next) this.chains.delete(key);
        if (this.pending === 0) this.waiters.splice(0).forEach((w) => w());
      });
    this.chains.set(key, next);
  }

  isIdle(): boolean {
    return this.pending === 0;
  }

  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }
}
