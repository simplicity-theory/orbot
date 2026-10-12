import {
  ConflictException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type {
  DisputeBody,
  DisputeView,
  RecordEvent,
  RecordVersion,
  Ruling,
  UnitBody,
} from '@orbot/shared';
import type { Subscription } from 'rxjs';
import { Background } from '../common/background.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { toView } from '../domain/view.js';
import { TaskRunner } from '../execution/task-runner.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService, type RecordWriter } from '../record/record.service.js';
import { RuntimeRegistry } from '../runtime/runtime.registry.js';
import { HQ_ACTOR } from './overseers.js';

/**
 * Disputes between units. A bot raises one about its task (the task waits). HQ rules at
 * once under the two units' standing orders, citing the order that settles it, and the
 * task carries on with the ruling in its brief. When no standing order settles it, HQ
 * refers it to the Commander. The Commander can rule on any dispute, upholding or
 * overturning HQ: that ruling is final.
 */
@Injectable()
export class DisputeService implements OnApplicationBootstrap, OnModuleDestroy {
  private sub: Subscription | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly runtimes: RuntimeRegistry,
    private readonly runner: TaskRunner,
  ) {}

  onApplicationBootstrap(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type !== 'event' || n.event.kind !== 'dispute.raised') return;
      const e = n.event as RecordEvent<'dispute.raised'>;
      this.background.run('hq:disputes', 'dispute', () => this.open(e));
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  /** A bot raised a dispute: open it, and have HQ rule. */
  private async open(e: RecordEvent<'dispute.raised'>) {
    if (!e.taskId || !e.unitId) return;
    const units = await this.record.listActive('unit');
    const against = units.find(
      (u) => u.body.name.toLowerCase() === e.body.against.trim().toLowerCase(),
    );
    const task = await this.record.requireActive('task', e.taskId);
    const mission = task.body.missionId
      ? await this.record.getActive('mission', task.body.missionId)
      : null;
    if (!against || against.entityId === e.unitId) {
      await this.record.event(
        'sitrep',
        {
          level: 'hq',
          text: `Task #${task.body.number} raised a dispute with “${e.body.against}”, which is not another unit. Referred to the Commander as a block.`,
          status: null,
        },
        { unitId: e.unitId, taskId: e.taskId },
        HQ_ACTOR,
      );
      return;
    }
    const dispute = await this.record.create(
      'dispute',
      {
        unitId: e.unitId,
        againstUnitId: against.entityId,
        taskId: e.taskId,
        botId: e.botId,
        operationId: mission?.body.operationId ?? null,
        claim: e.body.claim,
        status: 'open',
      },
      { actor: e.actor, reason: `Dispute raised with ${against.body.name}` },
    );
    await this.hqRules(dispute.entityId);
  }

  /** HQ rules under standing orders, or refers it upward. */
  private async hqRules(id: string) {
    const d = await this.record.requireActive('dispute', id);
    const [raiser, other, task] = await Promise.all([
      this.record.requireActive('unit', d.body.unitId),
      this.record.requireActive('unit', d.body.againstUnitId),
      this.record.requireActive('task', d.body.taskId),
    ]);
    const side = (u: RecordVersion<UnitBody>) => ({
      id: u.entityId,
      name: u.body.name,
      standingOrders: u.body.standingOrders,
    });
    const ruling = await this.runtimes.get(this.config.defaultRuntime).ruleDispute({
      claim: d.body.claim,
      raiser: side(raiser),
      other: side(other),
      task: {
        number: task.body.number,
        title: task.body.title,
        description: task.body.description,
      },
    });
    // Only orders that really exist count as citations: HQ rules under standing orders.
    const real = new Map(
      [raiser, other].flatMap((u) => u.body.standingOrders.map((o) => [o.id, { u, o }] as const)),
    );
    const cited = ruling.cited
      .map((c) => (c.orderId ? real.get(c.orderId) : undefined))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map(({ u, o }) => ({ unitId: u.entityId, orderId: o.id, text: o.text }));

    if (!ruling.prevails || !cited.length) {
      await this.record.transaction(async (w) => {
        await w.revise('dispute', id, (b) => ({ ...b, status: 'referred' }), {
          actor: HQ_ACTOR,
          reason: 'No standing order settles it: referred to the Commander',
        });
        await this.sitreps(
          w,
          d.body,
          `HQ: the dispute between ${raiser.body.name} and ${other.body.name} on task #${task.body.number} is not settled by any standing order. Referred to the Commander.`,
        );
      });
      return;
    }
    const hqRuling: Ruling = {
      prevails: ruling.prevails,
      reasoning: ruling.reasoning,
      cited,
      by: HQ_ACTOR,
      at: new Date().toISOString(),
    };
    const winner = ruling.prevails === 'raiser' ? raiser : other;
    await this.record.transaction(async (w) => {
      await w.revise('dispute', id, (b) => ({ ...b, status: 'ruled', hqRuling }), {
        actor: HQ_ACTOR,
        reason: `HQ ruled: ${winner.body.name} prevails`,
      });
      await this.sitreps(
        w,
        d.body,
        `HQ ruled on task #${task.body.number}: ${winner.body.name} prevails, under “${cited[0]!.text}”. The Commander may overturn it.`,
      );
    });
    await this.resume(d.body.taskId);
  }

  /** The Commander's ruling: final. Upholds or overturns HQ, or settles a referred dispute. */
  async rule(id: string, prevails: 'raiser' | 'other', reasoning: string, actor: string) {
    const d = await this.record.requireActive('dispute', id);
    if (d.body.status === 'final') {
      throw new ConflictException({
        message: 'You have already ruled on this dispute; your ruling is final.',
        action: 'To change course, give a new order (a frago or a mission).',
      });
    }
    const [raiser, other, task] = await Promise.all([
      this.record.requireActive('unit', d.body.unitId),
      this.record.requireActive('unit', d.body.againstUnitId),
      this.record.requireActive('task', d.body.taskId),
    ]);
    const winner = prevails === 'raiser' ? raiser : other;
    const verdict = !d.body.hqRuling
      ? 'ruled'
      : d.body.hqRuling.prevails === prevails
        ? 'upheld HQ'
        : 'overturned HQ';
    const commanderRuling: Ruling = {
      prevails,
      reasoning,
      cited: [],
      by: actor,
      at: new Date().toISOString(),
    };
    const saved = await this.record.transaction(async (w) => {
      const v = await w.revise('dispute', id, (b) => ({ ...b, status: 'final', commanderRuling }), {
        actor,
        reason: `The Commander ${verdict}: ${winner.body.name} prevails`,
      });
      await this.sitreps(
        w,
        d.body,
        `The Commander ${verdict} on task #${task.body.number} (${raiser.body.name} v ${other.body.name}): ${winner.body.name} prevails. ${reasoning}`,
      );
      return v;
    });
    if (task.body.status === 'blocked') await this.resume(d.body.taskId);
    else if (this.runner.isRunning(d.body.taskId)) {
      await this.runner.frago(
        d.body.taskId,
        `Final ruling by the Commander: ${winner.body.name} prevails. ${reasoning}`,
        null,
        actor,
      );
    }
    return saved;
  }

  /** The disputed task carries on, with the ruling in its brief. */
  private async resume(taskId: string) {
    const task = await this.record.getActive('task', taskId);
    if (task?.body.status !== 'blocked' || this.runner.isRunning(taskId)) return;
    await this.runner.start(taskId, HQ_ACTOR).catch(async (err: Error) => {
      await this.record.event(
        'sitrep',
        {
          level: 'hq',
          text: `Could not resume task #${task.body.number} after the ruling: ${err.message}`,
          status: null,
        },
        { unitId: task.body.unitId, taskId },
        HQ_ACTOR,
      );
    });
  }

  private async sitreps(w: RecordWriter, d: DisputeBody, text: string) {
    for (const unitId of [d.unitId, d.againstUnitId]) {
      await w.event(
        'sitrep',
        { level: 'hq', text, status: null },
        { unitId, taskId: unitId === d.unitId ? d.taskId : null, operationId: d.operationId },
        HQ_ACTOR,
      );
    }
  }

  async list(): Promise<DisputeView[]> {
    const [disputes, units, tasks, bots] = await Promise.all([
      this.record.listActive('dispute'),
      this.record.listActive('unit'),
      this.record.listActive('task'),
      this.record.listActive('bot'),
    ]);
    const name = (id: string) => units.find((u) => u.entityId === id)?.body.name ?? '';
    return disputes
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => {
        const t = tasks.find((x) => x.entityId === d.body.taskId);
        return {
          ...toView(d),
          unitName: name(d.body.unitId),
          againstUnitName: name(d.body.againstUnitId),
          taskNumber: t?.body.number ?? 0,
          taskTitle: t?.body.title ?? '',
          botCallsign: bots.find((b) => b.entityId === d.body.botId)?.body.callsign ?? null,
        };
      });
  }
}
