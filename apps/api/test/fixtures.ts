import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { BotEvent, BotRuntime, RunContext, TaskBrief } from '@orbot/shared';
import { git } from '../src/common/git.js';
import { ForceService } from '../src/domain/force.service.js';
import { RuntimeRegistry } from '../src/runtime/runtime.registry.js';
import { SimulatedRuntime } from '../src/runtime/simulated.runtime.js';

/** A throwaway git repository with one commit on `main`. */
export async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'orbot-test-repo-'));
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  await git(dir, ['init', '--quiet', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', 'init']);
  return dir;
}

/** One unit with an Overseer and one bot, created through the same services the app uses. */
export async function makeUnitWithBot(app: INestApplication, name = 'Engineers') {
  const force = app.get(ForceService);
  const ctx = { actor: 'system:test', reason: 'test fixture' };
  const unit = await force.createUnit(
    {
      name,
      slug: name.toLowerCase(),
      role: 'Developers',
      standingMission: 'Build features and fix bugs to spec.',
      callsignPrefix: 'E',
      overseerBotId: null,
      approvalGate: 'backbriefs-and-deploys',
      rulesOfEngagement: { mayDoAlone: [], mustEscalate: [] },
      standingOrders: [],
      supplyIds: [],
      order: 1,
    },
    ctx,
  );
  const bot = await force.createBot(
    {
      unitId: unit.entityId,
      callsign: 'E-1',
      role: 'Developer',
      isOverseer: false,
      status: 'idle',
      currentTaskId: null,
      queue: [],
      runtime: 'simulated',
    },
    ctx,
  );
  return { unit, bot };
}

/** Wraps the simulated runtime and keeps every event it yields, so tests can account for each one. */
export class SpyRuntime implements BotRuntime {
  readonly kind = 'simulated';
  readonly yielded: BotEvent[] = [];
  private readonly inner = new SimulatedRuntime();

  async *run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent> {
    for await (const ev of this.inner.run(brief, ctx)) {
      this.yielded.push(ev);
      yield ev;
    }
  }

  install(app: INestApplication): this {
    app.get(RuntimeRegistry).register(this);
    return this;
  }
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}
