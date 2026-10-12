import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Interpretation,
  type BotRuntime,
  type ChatAction,
  type ChatSendResult,
  type ChatView,
  type InterpretInput,
  type OrdersLogEntryView,
  type RecordEvent,
} from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { OverseerService } from '../overseer/overseer.service.js';
import { Overseers } from '../overseer/overseers.js';
import { RecordService } from '../record/record.service.js';
import { RuntimeRegistry } from '../runtime/runtime.registry.js';
import { SettingsService } from '../settings/settings.service.js';
import { ActionsService } from './actions.service.js';

const HQ = 'hq';
const HQ_ACTOR = 'system:hq';

type Readback = RecordEvent<'chat.readback'>['body'];
type ReadbackItem = Readback['items'][number];

/**
 * Chat is command. A Commander message is recorded, read by the addressed Overseer
 * (through its runtime), and turned into typed actions that run through the same
 * services the UI uses. Every change goes in the orders log and is read back.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly overseers: Overseers,
    private readonly runtimes: RuntimeRegistry,
    private readonly actions: ActionsService,
    private readonly overseer: OverseerService,
    private readonly settings: SettingsService,
  ) {}

  async send(channel: string, text: string, actor: string): Promise<ChatSendResult> {
    const unitId = await this.channelUnit(channel);
    const message = (await this.record.event(
      'chat.message',
      { channel, from: 'commander', text, relayedFrom: null },
      { unitId },
      actor,
    )) as RecordEvent<'chat.message'>;

    const { runtime, overseerActor } = await this.reader(unitId);
    const interpretation = Interpretation.parse(
      await runtime.interpret(await this.context(message.body.text, unitId)),
    );
    const settings = await this.settings.get();

    const items: ReadbackItem[] = [];
    const pending: Readback['pending'] = [];
    for (const action of interpretation.actions) {
      if (settings.irreversibleActions.includes(action.kind)) {
        pending.push(
          await this.hold(
            action,
            message,
            channel,
            'irreversible',
            settings.confirmationPhrase,
            overseerActor,
          ),
        );
      } else {
        items.push(
          await this.execute(action, message.id, channel, actor, {
            reason: `Chat order: “${text}”`,
          }),
        );
      }
    }
    for (const action of interpretation.musings) {
      pending.push(await this.hold(action, message, channel, 'musing', null, overseerActor));
    }

    const readback = (await this.record.event(
      'chat.readback',
      {
        channel,
        replyTo: message.id,
        kinds: interpretation.kinds,
        text: this.headline(interpretation, items, pending),
        answer: interpretation.answer,
        items,
        pending,
        missing: interpretation.missing.map((m) => m.what),
        unclear: interpretation.unclear,
      },
      { unitId },
      overseerActor,
    )) as RecordEvent<'chat.readback'>;
    return { message, readback };
  }

  /** Run an action, write its orders-log entry, relay via HQ if it is for another unit, reach live work. */
  private async execute(
    action: ChatAction,
    messageId: string | null,
    channel: string,
    actor: string,
    opts: { reason: string; reverses?: string },
  ): Promise<ReadbackItem> {
    const channelUnit = channel === HQ ? null : channel;
    const routedVia = action.unitId !== channelUnit ? HQ : null;
    const result = await this.actions.run(action, { actor, reason: opts.reason });
    const entry = await this.record.event(
      'orders.log',
      {
        messageId,
        channel,
        action,
        summary: result.summary,
        links: result.links,
        inverse: result.inverse,
        reverses: opts.reverses ?? null,
        routedVia,
      },
      { unitId: action.unitId },
      actor,
    );
    if (routedVia && channel !== action.unitId) {
      // The other unit's Overseer hears it in its own channel, relayed by HQ.
      await this.record.event(
        'chat.message',
        {
          channel: action.unitId,
          from: 'hq',
          text: `Order from the Commander, relayed by HQ: ${result.summary}`,
          relayedFrom: channel,
        },
        { unitId: action.unitId },
        HQ_ACTOR,
      );
    }
    this.overseer.applyToLiveWork(
      action.unitId,
      { summary: result.summary, affects: result.affects },
      actor,
    );
    return {
      ordersLogId: entry.id,
      summary: result.summary,
      links: result.links,
      reversible: !!result.inverse,
      routedVia,
    };
  }

  private async hold(
    action: ChatAction,
    message: RecordEvent<'chat.message'>,
    channel: string,
    reason: 'musing' | 'irreversible',
    phrase: string | null,
    overseerActor: string,
  ) {
    const summary = await this.describe(action);
    const ev = await this.record.event(
      'pending.action',
      { messageId: message.id, channel, action, summary, reason, phrase },
      { unitId: action.unitId },
      overseerActor,
    );
    return { pendingId: ev.id, summary, reason, phrase };
  }

  /** "Yes, do it" on a musing, or the typed confirmation of an irreversible order. */
  async confirm(
    pendingId: string,
    phrase: string | undefined,
    actor: string,
  ): Promise<ChatSendResult['readback']> {
    const p = await this.pending(pendingId);
    if (p.body.reason === 'irreversible') {
      const want = p.body.phrase ?? (await this.settings.get()).confirmationPhrase;
      if ((phrase ?? '').trim().toLowerCase() !== want.toLowerCase()) {
        throw new BadRequestException({
          message: 'This order cannot be undone, so it needs your confirmation.',
          action: `Type “${want}” to go ahead.`,
        });
      }
    }
    const item = await this.execute(p.body.action, p.body.messageId, p.body.channel, actor, {
      reason:
        p.body.reason === 'irreversible'
          ? 'Irreversible order confirmed by the Commander'
          : 'Confirmed as an order',
    });
    await this.record.event(
      'pending.resolved',
      { pendingId, outcome: 'confirmed', ordersLogId: item.ordersLogId },
      { unitId: p.unitId },
      actor,
    );
    const unitId = p.body.channel === HQ ? null : p.body.channel;
    const { overseerActor } = await this.reader(unitId);
    return (await this.record.event(
      'chat.readback',
      {
        channel: p.body.channel,
        replyTo: p.body.messageId,
        kinds: [],
        text: 'Wilco.',
        answer: null,
        items: [item],
        pending: [],
        missing: [],
        unclear: [],
      },
      { unitId },
      overseerActor,
    )) as RecordEvent<'chat.readback'>;
  }

  async decline(pendingId: string, actor: string) {
    const p = await this.pending(pendingId);
    await this.record.event(
      'pending.resolved',
      { pendingId, outcome: 'declined', ordersLogId: null },
      { unitId: p.unitId },
      actor,
    );
    const unitId = p.body.channel === HQ ? null : p.body.channel;
    const { overseerActor } = await this.reader(unitId);
    return this.record.event(
      'chat.message',
      {
        channel: p.body.channel,
        from: 'overseer',
        text: `Understood — nothing changed (“${p.body.summary}”).`,
        relayedFrom: null,
      },
      { unitId },
      overseerActor,
    );
  }

  /** Undo: a new orders-log entry that runs the inverse. The original stays in the log. */
  async undo(entryId: string, actor: string) {
    const entry = await this.record.getEvent(entryId);
    if (!entry || entry.kind !== 'orders.log')
      throw new NotFoundException(`No orders-log entry ${entryId}.`);
    const e = entry as RecordEvent<'orders.log'>;
    if (!e.body.inverse) {
      throw new ConflictException({
        message: 'That change cannot be undone.',
        action: 'Give a new order (or a frago) to change it.',
      });
    }
    const [already] = await this.record.findEvents(
      ['orders.log'],
      { reverses: entryId },
      { limit: 1 },
    );
    if (already)
      throw new ConflictException({
        message: 'That change has already been undone.',
        action: 'See the orders log for the reversing entry.',
      });
    const item = await this.execute(e.body.inverse, null, e.body.channel, actor, {
      reason: `Undo: ${e.body.summary}`,
      reverses: entryId,
    });
    const unitId = e.body.channel === HQ ? null : e.body.channel;
    const { overseerActor } = await this.reader(unitId);
    await this.record.event(
      'chat.message',
      {
        channel: e.body.channel,
        from: 'overseer',
        text: `Undone. ${item.summary}`,
        relayedFrom: null,
      },
      { unitId },
      overseerActor,
    );
    return item;
  }

  async view(channel: string): Promise<ChatView> {
    const unitId = await this.channelUnit(channel);
    const items = await this.record.findEvents(
      ['chat.message', 'chat.readback'],
      { channel },
      { limit: 500, latest: true },
    );
    const reversals = await this.record.findEvents(['orders.log'], { channel }, { limit: 2000 });
    const resolutions = (await this.record.findEvents(
      ['pending.resolved'],
      {},
      { limit: 2000 },
    )) as RecordEvent<'pending.resolved'>[];
    let label = 'HQ';
    if (unitId) {
      const unit = await this.record.requireActive('unit', unitId);
      const o = unit.body.overseerBotId
        ? await this.record.getActive('bot', unit.body.overseerBotId)
        : null;
      label = `${unit.body.name} Overseer${o ? ` (${o.body.callsign})` : ''}`;
    }
    return {
      channel,
      label,
      unitId,
      items,
      reversed: Object.fromEntries(
        (reversals as RecordEvent<'orders.log'>[])
          .filter((r) => r.body.reverses)
          .map((r) => [r.body.reverses!, r.id]),
      ),
      resolved: Object.fromEntries(resolutions.map((r) => [r.body.pendingId, r.body.outcome])),
    };
  }

  async ordersLog(filter: { unitId?: string } = {}): Promise<OrdersLogEntryView[]> {
    const entries = (await this.record.listEvents(
      { kinds: ['orders.log'], limit: 500, ...(filter.unitId ? { unitId: filter.unitId } : {}) },
      { latest: true },
    )) as RecordEvent<'orders.log'>[];
    const units = new Map(
      (await this.record.listActive('unit')).map((u) => [u.entityId, u.body.name]),
    );
    const reversedBy = new Map(
      entries.filter((e) => e.body.reverses).map((e) => [e.body.reverses!, e.id]),
    );
    const out: OrdersLogEntryView[] = [];
    for (const e of [...entries].reverse()) {
      const message = e.body.messageId
        ? ((await this.record.getEvent(e.body.messageId)) as RecordEvent<'chat.message'> | null)
        : null;
      out.push({
        entry: e,
        reversedBy: reversedBy.get(e.id) ?? null,
        message,
        unitName: units.get(e.unitId ?? '') ?? '',
      });
    }
    return out;
  }

  // ---------- helpers ----------

  private async channelUnit(channel: string): Promise<string | null> {
    if (channel === HQ) return null;
    await this.record.requireActive('unit', channel);
    return channel;
  }

  /** The Overseer (or, for HQ, the default runtime until HQ exists in Phase 4) that reads the message. */
  private async reader(
    unitId: string | null,
  ): Promise<{ runtime: BotRuntime; overseerActor: string }> {
    if (!unitId)
      return { runtime: this.runtimes.get(this.config.defaultRuntime), overseerActor: HQ_ACTOR };
    const cmd = await this.overseers.of(unitId);
    return { runtime: cmd.runtime, overseerActor: cmd.actor };
  }

  private async context(message: string, channelUnitId: string | null): Promise<InterpretInput> {
    const [units, bots, tasks, missions, supply] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('task'),
      this.record.listActive('mission'),
      this.record.listActive('supply'),
    ]);
    const callsign = new Map(bots.map((b) => [b.entityId, b.body.callsign]));
    return {
      message,
      channelUnitId,
      units: units.map((u) => {
        const ut = tasks.filter((t) => t.body.unitId === u.entityId);
        return {
          id: u.entityId,
          name: u.body.name,
          slug: u.body.slug,
          standingOrders: u.body.standingOrders,
          supplyIds: u.body.supplyIds,
          computeBudget: u.body.computeBudget ?? 0,
          tasks: ut.map((t) => ({
            id: t.entityId,
            number: t.body.number,
            title: t.body.title,
            status: t.body.status,
            statusReason: t.body.statusReason,
            missionId: t.body.missionId,
            botCallsign: t.body.botId ? (callsign.get(t.body.botId) ?? null) : null,
          })),
          missions: missions
            .filter((m) => m.body.unitId === u.entityId)
            .map((m) => {
              const mt = ut.filter((t) => t.body.missionId === m.entityId);
              return {
                id: m.entityId,
                goal: m.body.goal,
                status: m.body.status,
                done: mt.filter((t) => t.body.status === 'done').length,
                total: mt.length,
              };
            }),
        };
      }),
      depot: supply.map((s) => ({
        id: s.entityId,
        name: s.body.name,
        kind: s.body.spec.kind,
        connected: s.body.connected,
        tier: s.body.spec.kind === 'environment' ? (s.body.spec.details['tier'] ?? null) : null,
      })),
    };
  }

  private async pending(pendingId: string) {
    const p = await this.record.getEvent(pendingId);
    if (!p || p.kind !== 'pending.action')
      throw new NotFoundException(`No pending order ${pendingId}.`);
    const [done] = await this.record.findEvents(['pending.resolved'], { pendingId }, { limit: 1 });
    if (done)
      throw new ConflictException({
        message: 'You already answered that.',
        action: 'See the chat for what happened.',
      });
    return p as RecordEvent<'pending.action'>;
  }

  /** A one-line, human description of an action that has not run yet. */
  private async describe(a: ChatAction): Promise<string> {
    const unit = await this.record.requireActive('unit', a.unitId);
    const u = unit.body.name;
    switch (a.kind) {
      case 'budget-grant':
        return `Raise ${u}'s compute budget by ${a.units} units`;
      case 'supply-grant':
      case 'grant-deploy-rights': {
        const s = await this.record.requireActive('supply', a.supplyId);
        return a.kind === 'grant-deploy-rights'
          ? `Give ${u} deploy rights to ${s.body.name} (cannot be undone)`
          : `Issue ${s.body.name} to ${u}`;
      }
      case 'create-mission':
        return `Give ${u} the mission “${a.goal}”`;
      case 'rule-change':
        return `Change ${u}'s standing orders: ${a.addOrders.map((o) => `add “${o}”`).join('; ')}`;
      case 'frago':
        return `${a.change === 'stand-down' ? 'Stand down' : 'Amend'} ${a.taskIds.length} task(s) in ${u}`;
      default:
        return `${a.kind} for ${u}`;
    }
  }

  private headline(i: Interpretation, items: ReadbackItem[], pending: Readback['pending']): string {
    if (items.length) return 'Wilco.';
    if (pending.some((p) => p.reason === 'irreversible'))
      return 'That cannot be undone. Confirm and I will act.';
    if (pending.length) return 'Did you mean that as an order?';
    if (i.missing.length) return 'I cannot do that yet: it is not in the Supply Depot.';
    if (i.answer) return i.answer;
    return 'Say again? I did not catch an order or a question.';
  }
}
