import { Injectable, NotFoundException } from '@nestjs/common';
import type { BotRuntime } from '@orbot/shared';

/** Maps a bot's `runtime` name to the adapter that drives it. */
@Injectable()
export class RuntimeRegistry {
  private readonly runtimes = new Map<string, BotRuntime>();

  register(runtime: BotRuntime): void {
    this.runtimes.set(runtime.kind, runtime);
  }

  get(kind: string): BotRuntime {
    const r = this.runtimes.get(kind);
    if (!r) {
      throw new NotFoundException({
        message: `No bot runtime called "${kind}" is installed.`,
        action: `Use one of: ${[...this.runtimes.keys()].join(', ')}.`,
      });
    }
    return r;
  }

  kinds(): string[] {
    return [...this.runtimes.keys()];
  }
}
