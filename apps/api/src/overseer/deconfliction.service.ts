import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type {
  DeconflictionView,
  RecordEvent,
  RecordVersion,
  SupplyBody,
  TaskBody,
  Toucher,
  TouchOverlap,
} from '@orbot/shared';
import type { Subscription } from 'rxjs';
import { Background } from '../common/background.js';
import { TaskRunner } from '../execution/task-runner.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService } from '../record/record.service.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { HQ_ACTOR } from './hq.service.js';

/** Tasks still in play: their branch may yet land. Done and failed work is out of it. */
const ACTIVE = new Set(['queued', 'working', 'blocked', 'stood-down', 'awaiting-approval']);

interface Touch {
  task: RecordVersion<TaskBody>;
  files: string[];
}

/**
 * Deconfliction. Every task already works in its own worktree on its own branch; HQ keeps
 * track of who touches what. When a task writes or commits a file that another active task
 * in the same repository is also changing, HQ records it once per pair (and per new file),
 * tells both running bots by frago, and posts an HQ sitrep. The map is always worked out
 * from git, so it cannot drift from what the branches hold.
 */
@Injectable()
export class DeconflictionService implements OnApplicationBootstrap, OnModuleDestroy {
  private sub: Subscription | null = null;

  constructor(
    private readonly record: RecordService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: TaskRunner,
  ) {}

  onApplicationBootstrap(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type !== 'event' || n.event.kind !== 'artifact' || !n.event.taskId) return;
      const kind = (n.event as RecordEvent<'artifact'>).body.kind;
      if (kind !== 'file' && kind !== 'commit') return;
      const taskId = n.event.taskId;
      this.background.run('hq:deconfliction', 'deconfliction', () => this.check(taskId));
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  /** Every active task with a workspace in this repository (or all), and the files it changes. */
  private async touches(repoSupplyId?: string): Promise<Touch[]> {
    const tasks = (await this.record.listActive('task')).filter(
      (t) =>
        ACTIVE.has(t.body.status) &&
        t.body.workspace &&
        (!repoSupplyId || t.body.workspace.repoSupplyId === repoSupplyId),
    );
    const supply = new Map<string, RecordVersion<SupplyBody> | null>();
    const out: Touch[] = [];
    for (const task of tasks) {
      const ws = task.body.workspace!;
      if (!supply.has(ws.repoSupplyId))
        supply.set(ws.repoSupplyId, await this.record.getActive('supply', ws.repoSupplyId));
      const repo = supply.get(ws.repoSupplyId);
      if (!repo) continue;
      const files = await this.workspaces.touched(repo.body, ws, task.body.baseRef ?? null);
      if (files.length) out.push({ task, files });
    }
    return out;
  }

  /** A task just changed files: does it now overlap with another active task? */
  async check(taskId: string): Promise<void> {
    const task = await this.record.getActive('task', taskId);
    const ws = task?.body.workspace;
    if (!task || !ws || !ACTIVE.has(task.body.status)) return;
    const all = await this.touches(ws.repoSupplyId);
    const mine = all.find((t) => t.task.entityId === taskId);
    if (!mine) return;
    for (const other of all) {
      if (other.task.entityId === taskId) continue;
      // Work in one operation lands in order on its integration branch: not a conflict.
      if (task.body.baseRef && task.body.baseRef === other.task.body.baseRef) continue;
      const shared = mine.files.filter((f) => other.files.includes(f));
      if (!shared.length) continue;
      const pair = [other.task, task].sort((a, b) => a.body.number - b.body.number);
      const known = new Set(
        (
          await this.record.findEvents(['deconfliction'], {
            taskIds: pair.map((p) => p.entityId),
          })
        ).flatMap((e) => (e as RecordEvent<'deconfliction'>).body.paths),
      );
      const fresh = shared.filter((f) => !known.has(f));
      if (!fresh.length) continue;
      await this.notice(pair, fresh, ws.repoSupplyId);
    }
  }

  private async notice(pair: RecordVersion<TaskBody>[], paths: string[], repoSupplyId: string) {
    const [a, b] = pair as [RecordVersion<TaskBody>, RecordVersion<TaskBody>];
    const who = async (t: RecordVersion<TaskBody>) => {
      const unit = await this.record.getActive('unit', t.body.unitId);
      const bot = t.body.botId ? await this.record.getActive('bot', t.body.botId) : null;
      return `task #${t.body.number} (${unit?.body.name ?? 'unit'}${bot ? `, ${bot.body.callsign}` : ''})`;
    };
    const [wa, wb] = [await who(a), await who(b)];
    const list = paths.map((p) => `\`${p}\``).join(', ');
    await this.record.transaction(async (w) => {
      await w.event(
        'deconfliction',
        {
          repoSupplyId,
          paths,
          taskIds: [a.entityId, b.entityId],
          unitIds: [...new Set([a.body.unitId, b.body.unitId])],
        },
        { unitId: b.body.unitId, taskId: b.entityId, botId: b.body.botId },
        HQ_ACTOR,
      );
      await w.event(
        'sitrep',
        {
          level: 'hq',
          text: `Deconfliction: ${wa} and ${wb} both change ${list}. Each keeps its own branch; whichever lands second rebases on the first.`,
          status: null,
        },
        { unitId: b.body.unitId, taskId: b.entityId },
        HQ_ACTOR,
      );
    });
    for (const [mine, theirs] of [
      [a, wb],
      [b, wa],
    ] as const) {
      await this.runner.frago(
        mine.entityId,
        `HQ deconfliction: ${theirs} is also changing ${list}. Keep your change to ${
          paths.length > 1 ? 'those files' : 'that file'
        } small and self-contained, and say so in your handover; whichever lands second rebases.`,
        null,
        HQ_ACTOR,
      );
    }
  }

  /** Who touches what, across every repository. */
  async view(): Promise<DeconflictionView> {
    const [touches, units, bots, supply, notices] = await Promise.all([
      this.touches(),
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('supply'),
      this.record.listEvents({ kinds: ['deconfliction'], limit: 50 }, { latest: true }),
    ]);
    const toucher = (t: RecordVersion<TaskBody>): Toucher => {
      const bot = bots.find((b) => b.entityId === t.body.botId);
      return {
        taskId: t.entityId,
        number: t.body.number,
        title: t.body.title,
        status: t.body.status,
        unitId: t.body.unitId,
        unitName: units.find((u) => u.entityId === t.body.unitId)?.body.name ?? '',
        botId: t.body.botId,
        callsign: bot?.body.callsign ?? null,
        branch: t.body.workspace!.branch,
      };
    };
    const byRepo = new Map<string, Map<string, Toucher[]>>();
    for (const { task, files } of touches) {
      const repoId = task.body.workspace!.repoSupplyId;
      const files0 = byRepo.get(repoId) ?? new Map<string, Toucher[]>();
      for (const f of files) files0.set(f, [...(files0.get(f) ?? []), toucher(task)]);
      byRepo.set(repoId, files0);
    }
    const repos = [...byRepo.entries()].map(([id, files]) => ({
      id,
      name: supply.find((s) => s.entityId === id)?.body.name ?? 'repository',
      files: [...files.entries()]
        .map(([path, tasks]) => ({ path, tasks: tasks.sort((x, y) => x.number - y.number) }))
        // Overlaps first, then by path.
        .sort(
          (x, y) =>
            Number(y.tasks.length > 1) - Number(x.tasks.length > 1) || x.path.localeCompare(y.path),
        ),
    }));
    return {
      repos,
      overlaps: repos.reduce((n, r) => n + r.files.filter((f) => f.tasks.length > 1).length, 0),
      notices,
    };
  }

  /** The files a task shares with other active tasks. */
  async overlapsFor(taskId: string): Promise<TouchOverlap[]> {
    const task = await this.record.getActive('task', taskId);
    const ws = task?.body.workspace;
    if (!task || !ws || !ACTIVE.has(task.body.status)) return [];
    const view = await this.view();
    const repo = view.repos.find((r) => r.id === ws.repoSupplyId);
    return (repo?.files ?? [])
      .filter((f) => f.tasks.length > 1 && f.tasks.some((t) => t.taskId === taskId))
      .map((f) => ({ path: f.path, others: f.tasks.filter((t) => t.taskId !== taskId) }));
  }
}
