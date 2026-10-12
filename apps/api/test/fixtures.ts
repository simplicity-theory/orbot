import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { BotEvent, RunContext, TaskBrief } from '@orbot/shared';
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

export interface UnitFixtureOptions {
  name?: string;
  /** Give the unit an Overseer (default true). */
  overseer?: boolean;
  gate?: 'approve-everything' | 'backbriefs-and-deploys' | 'escalations-only';
  bots?: number;
  supplyIds?: string[];
}

/** One unit with an Overseer and bots, created through the same services the app uses. */
export async function makeUnitWithBot(
  app: INestApplication,
  nameOrOpts: string | UnitFixtureOptions = {},
) {
  const opts = typeof nameOrOpts === 'string' ? { name: nameOrOpts } : nameOrOpts;
  const name = opts.name ?? 'Engineers';
  const force = app.get(ForceService);
  const ctx = { actor: 'system:test', reason: 'test fixture' };
  const overseerId = opts.overseer === false ? null : randomUUID();
  const unit = await force.createUnit(
    {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      role: 'Developers',
      standingMission: 'Build features and fix bugs to spec.',
      callsignPrefix: 'E',
      overseerBotId: overseerId,
      approvalGate: opts.gate ?? 'backbriefs-and-deploys',
      rulesOfEngagement: { mayDoAlone: [], mustEscalate: [] },
      standingOrders: [],
      supplyIds: opts.supplyIds ?? [],
      order: 1,
    },
    ctx,
  );
  const base = {
    unitId: unit.entityId,
    status: 'idle' as const,
    currentTaskId: null,
    queue: [],
    runtime: 'simulated',
  };
  const overseer = overseerId
    ? await force.createBot(
        { ...base, callsign: 'E-0', role: 'Overseer', isOverseer: true },
        ctx,
        overseerId,
      )
    : null;
  const bots = [];
  for (let i = 1; i <= (opts.bots ?? 1); i++) {
    bots.push(
      await force.createBot(
        { ...base, callsign: `E-${i}`, role: 'Developer', isOverseer: false },
        ctx,
      ),
    );
  }
  return { unit, bot: bots[0]!, bots, overseer };
}

export { settled } from '../src/testing/settle.js';

/** Wraps the simulated runtime and keeps every event it yields, so tests can account for each one. */
export class SpyRuntime extends SimulatedRuntime {
  readonly yielded: BotEvent[] = [];

  override async *run(brief: TaskBrief, ctx: RunContext): AsyncIterable<BotEvent> {
    for await (const ev of super.run(brief, ctx)) {
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
