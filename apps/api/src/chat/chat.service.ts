import { AuthorityService } from '../officers/authority.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  describeHoldPolicy,
  Interpretation,
  SETTINGS_ID,
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
import { headline, type PendingReason } from './headline.js';
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
/** Orders about supply, budgets, operations and the main effort are the Commander's alone. */
/** "Do it", "Yes", "Go ahead": the last proposal becomes the order. */
const CONFIRM =
  /^(?:ok(?:ay)?[,.]?\s*)?(?:yes|yes please|do it|do that|go ahead|go for it|make it so|proceed|please do|sounds good|agreed|confirmed?|that one)[.!]*$/i;
/** Turns of the channel given to the interpreter as context. */
const HISTORY_TURNS = 12;

const COMMANDER_ONLY: ChatAction['kind'][] = [
  'new-project',
  'hold-policy',
  'supply-grant',
  'supply-revoke',
  'budget-grant',
  'grant-deploy-rights',
  'create-operation',
  'create-theatre',
  'assign-resource',
  'release-resource',
  'set-main-repository',
  'cancel-operation',
  'restart-operation',
  'restart-queues',
  'land-task',
  'main-effort',
];

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
    private readonly authority: AuthorityService,
  ) {}

  /** Why this person may not give this order, or null if they may (by rank and units). */
  private async refusal(action: ChatAction, actor: string): Promise<string | null> {
    // Rehearsing changes nothing: any officer may ask for one.
    if (action.kind === 'rehearse') return this.authority.refusal(actor, null, true);
    const units = COMMANDER_ONLY.includes(action.kind)
      ? null
      : action.unitId
        ? [action.unitId]
        : null;
    return this.authority.refusal(actor, units);
  }

  private async mayOrder(action: ChatAction, actor: string): Promise<void> {
    const why = await this.refusal(action, actor);
    if (why) {
      throw new ForbiddenException({
        message: why,
        action: 'Ask the Commander, or an officer who commands that unit.',
      });
    }
  }

  async send(channel: string, text: string, actor: string): Promise<ChatSendResult> {
    const unitId = await this.channelUnit(channel);
    const message = (await this.record.event(
      'chat.message',
      { channel, from: 'commander', text, relayedFrom: null },
      { unitId },
      actor,
    )) as RecordEvent<'chat.message'>;

    // "Do it": what the Overseer last proposed in this channel becomes the order.
    if (CONFIRM.test(text.trim())) {
      const confirmed = await this.confirmProposed(channel, unitId, message, actor);
      if (confirmed) return { message, readback: confirmed };
    }

    const { runtime, overseerActor } = await this.reader(unitId);
    const interpretation = Interpretation.parse(
      await runtime.interpret(await this.context(message, unitId)),
    );
    const settings = await this.settings.get();

    const items: ReadbackItem[] = [];
    const pending: Readback['pending'] = [];
    // Orders this officer may not give are read back as not done; nothing changes.
    const refused: string[] = [];
    const allowed = async (action: ChatAction) => {
      const why = await this.refusal(action, actor);
      if (why) refused.push(`Not done: ${await this.describe(action)} — ${why}`);
      return !why;
    };
    for (const action of interpretation.actions) {
      if (!(await allowed(action))) continue;
      if (settings.irreversibleActions.includes(action.kind) || (await this.drastic(action))) {
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
    // Proposals after a question (or beside an answer) are offers, not suspected orders.
    const proposed: PendingReason =
      interpretation.kinds.includes('question') || interpretation.answer ? 'offer' : 'musing';
    for (const action of interpretation.musings) {
      if (!(await allowed(action))) continue;
      pending.push(await this.hold(action, message, channel, proposed, null, overseerActor));
    }

    const readback = (await this.record.event(
      'chat.readback',
      {
        channel,
        replyTo: message.id,
        kinds: interpretation.kinds,
        text: headline(interpretation, items.length, pending, refused.length > 0),
        answer: interpretation.answer,
        items,
        pending,
        missing: interpretation.missing.map((m) => m.what),
        unclear: [...refused, ...interpretation.unclear],
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
    // Orders for another unit — and new operations — go through HQ.
    const routedVia =
      action.unitId !== channelUnit ||
      action.kind === 'create-operation' ||
      action.kind === 'create-theatre' ||
      action.kind === 'assign-resource' ||
      action.kind === 'release-resource' ||
      action.kind === 'set-main-repository' ||
      action.kind === 'cancel-operation' ||
      action.kind === 'restart-operation' ||
      action.kind === 'restart-queues'
        ? HQ
        : null;
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
    if (routedVia && action.unitId && channel !== action.unitId) {
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
    if (action.unitId) {
      this.overseer.applyToLiveWork(
        action.unitId,
        { summary: result.summary, affects: result.affects },
        actor,
      );
    }
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
    reason: PendingReason,
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
    await this.mayOrder(p.body.action, actor);
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
    await this.mayOrder(e.body.inverse, actor);
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

  /**
   * The musings still open from this channel's last read-back: what the Overseer proposed and
   * the Commander has neither confirmed nor declined.
   */
  private async openProposals(channel: string): Promise<RecordEvent<'pending.action'>[]> {
    const [last] = (await this.record.findEvents(
      ['chat.readback'],
      { channel },
      {
        limit: 1,
        latest: true,
      },
    )) as RecordEvent<'chat.readback'>[];
    const out: RecordEvent<'pending.action'>[] = [];
    for (const p of last?.body.pending ?? []) {
      const [done] = await this.record.findEvents(
        ['pending.resolved'],
        { pendingId: p.pendingId },
        {
          limit: 1,
        },
      );
      if (!done) out.push((await this.pending(p.pendingId)) as RecordEvent<'pending.action'>);
    }
    return out;
  }

  /** Confirms the open musings; irreversible proposals still need their typed phrase. */
  private async confirmProposed(
    channel: string,
    unitId: string | null,
    message: RecordEvent<'chat.message'>,
    actor: string,
  ): Promise<RecordEvent<'chat.readback'> | null> {
    const open = await this.openProposals(channel);
    if (!open.length) return null;
    const { overseerActor } = await this.reader(unitId);
    const items: ReadbackItem[] = [];
    const unclear: string[] = [];
    for (const p of open) {
      if (p.body.reason === 'irreversible') {
        const want = p.body.phrase ?? (await this.settings.get()).confirmationPhrase;
        unclear.push(`${p.body.summary} cannot be undone: type “${want}” to go ahead.`);
        continue;
      }
      await this.mayOrder(p.body.action, actor);
      const item = await this.execute(p.body.action, p.body.messageId, channel, actor, {
        reason: `Confirmed as an order: “${message.body.text}”`,
      });
      items.push(item);
      await this.record.event(
        'pending.resolved',
        { pendingId: p.id, outcome: 'confirmed', ordersLogId: item.ordersLogId },
        { unitId },
        actor,
      );
    }
    return (await this.record.event(
      'chat.readback',
      {
        channel,
        replyTo: message.id,
        kinds: items.length ? ['order'] : [],
        text: items.length ? 'Wilco.' : 'That cannot be undone. Confirm and I will act.',
        answer: null,
        items,
        pending: [],
        missing: [],
        unclear,
      },
      { unitId },
      overseerActor,
    )) as RecordEvent<'chat.readback'>;
  }

  /** The channel's recent turns, oldest first, without the message being interpreted. */
  private async history(
    channel: string,
    exceptMessageId: string,
  ): Promise<InterpretInput['history']> {
    const recent = (await this.record.findEvents(
      ['chat.message', 'chat.readback'],
      { channel },
      {
        limit: HISTORY_TURNS,
        latest: true,
      },
    )) as (RecordEvent<'chat.message'> | RecordEvent<'chat.readback'>)[];
    return recent
      .filter((e) => e.id !== exceptMessageId)
      .reverse()
      .map((e) =>
        e.kind === 'chat.message'
          ? { from: e.body.from, text: e.body.text }
          : {
              from: 'overseer' as const,
              text: [e.body.answer ?? e.body.text, ...e.body.items.map((i) => i.summary)].join(' '),
              ...(e.body.pending.length ? { proposed: e.body.pending.map((p) => p.summary) } : {}),
            },
      );
  }

  private async context(
    message: RecordEvent<'chat.message'>,
    channelUnitId: string | null,
  ): Promise<InterpretInput> {
    const [units, bots, tasks, missions, supply, settings] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('task'),
      this.record.listActive('mission'),
      this.record.listActive('supply'),
      this.record.getActive('settings', SETTINGS_ID),
    ]);
    const callsign = new Map(bots.map((b) => [b.entityId, b.body.callsign]));
    return {
      message: message.body.text,
      history: await this.history(message.body.channel, message.id),
      channelUnitId,
      units: units.map((u) => {
        const ut = tasks.filter((t) => t.body.unitId === u.entityId);
        return {
          id: u.entityId,
          name: u.body.name,
          slug: u.body.slug,
          standingOrders: u.body.standingOrders,
          holdPolicy: u.body.holdPolicy,
          supplyIds: u.body.supplyIds,
          computeBudget: u.body.computeBudget ?? 0,
          halted: !!u.body.halt,
          bots: bots
            .filter((b) => b.body.unitId === u.entityId && !b.body.isOverseer)
            .map((b) => ({
              id: b.entityId,
              callsign: b.body.callsign,
              status: b.body.status,
              halted: !!b.body.halt,
            })),
          tasks: ut.map((t) => ({
            id: t.entityId,
            number: t.body.number,
            title: t.body.title,
            status: t.body.status,
            statusReason: t.body.statusReason,
            missionId: t.body.missionId,
            botCallsign: t.body.botId ? (callsign.get(t.body.botId) ?? null) : null,
            kind: t.body.kind ?? 'work',
          })),
          missions: missions
            .filter((m) => m.body.unitId === u.entityId)
            .map((m) => {
              const mt = ut.filter((t) => t.body.missionId === m.entityId);
              return {
                id: m.entityId,
                goal: m.body.goal,
                status: m.body.status,
                stage: m.body.stage,
                operationId: m.body.operationId,
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
      operations: (await this.record.listActive('operation')).map((o) => ({
        id: o.entityId,
        name: o.body.name,
        phase: o.body.phase,
        supplyIds: o.body.supplyIds,
        holdPolicy: o.body.holdPolicy,
      })),
      allHalted: !!settings?.body.halt,
      mainEffortOperationId: settings?.body.mainEffort?.operationId ?? null,
      trackers: supply
        .filter(
          (s) =>
            s.body.spec.kind === 'connection' && s.body.connected && s.body.spec.services.issues,
        )
        .map((s) => ({ id: s.entityId, name: s.body.name })),
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

  /**
   * Orders that throw work away always need the typed confirmation, whatever the settings say:
   * cancelling an operation, or moving one whose missions are out to another repository.
   */
  private async drastic(a: ChatAction): Promise<boolean> {
    if (
      a.kind === 'cancel-operation' ||
      a.kind === 'restart-operation' ||
      a.kind === 'withdraw-mission' ||
      a.kind === 'restart-mission'
    )
      return true;
    if (a.kind !== 'set-main-repository') return false;
    const op = await this.record.getActive('operation', a.operationId);
    return !!op?.body.missionIds.length && op.body.repoSupplyId !== a.supplyId;
  }

  /** A one-line, human description of an action that has not run yet. */
  private async describe(a: ChatAction): Promise<string> {
    if (a.kind === 'create-operation') return `Launch Operation ${a.name}: “${a.intent}”`;
    if (a.kind === 'create-theatre')
      return `Open Theatre ${a.name}${a.repoSupplyId ? ' on an existing repository' : a.projectKind ? ' (one HTML file, published by ORBOT)' : ''}${a.intent ? `: “${a.intent}”` : ''}`;
    if (a.kind === 'hold-policy') {
      const what = a.policy ? describeHoldPolicy(a.policy) : 'back to each unit’s own setting';
      if (a.operationId) {
        const op = await this.record.requireActive('operation', a.operationId);
        return `Hold policy for Operation ${op.body.name}: ${what}`;
      }
      const unit = await this.record.requireActive('unit', a.unitId!);
      return `${unit.body.name}'s hold policy: ${what}`;
    }
    if (a.kind === 'new-project')
      return `Start project ${a.name} (one HTML file, published by ORBOT)${a.intent ? `: “${a.intent}”` : ''}`;
    if (a.kind === 'assign-resource' || a.kind === 'release-resource') {
      const op = await this.record.requireActive('operation', a.operationId);
      const s = await this.record.requireActive('supply', a.supplyId);
      return a.kind === 'assign-resource'
        ? `Assign ${s.body.name} to Operation ${op.body.name}`
        : `Take ${s.body.name} off Operation ${op.body.name}`;
    }
    if (a.kind === 'set-main-repository') {
      const op = await this.record.requireActive('operation', a.operationId);
      const s = await this.record.requireActive('supply', a.supplyId);
      return `Make ${s.body.name} the main repository of Operation ${op.body.name}${op.body.missionIds.length ? ' (its missions are withdrawn and issued again there)' : ''}`;
    }
    if (a.kind === 'cancel-operation') {
      const op = await this.record.requireActive('operation', a.operationId);
      return `Cancel Operation ${op.body.name}${a.note ? `: ${a.note}` : ''}`;
    }
    if (a.kind === 'restart-operation') {
      const op = await this.record.requireActive('operation', a.operationId);
      return `Start Operation ${op.body.name} over (its missions are withdrawn and issued again)${a.note ? `: ${a.note}` : ''}`;
    }
    if (a.kind === 'withdraw-mission' || a.kind === 'restart-mission') {
      const m = await this.record.requireActive('mission', a.missionId);
      return a.kind === 'withdraw-mission'
        ? `Abort the mission “${m.body.goal}” (its work stands down)${a.note ? `: ${a.note}` : ''}`
        : `Start the mission “${m.body.goal}” over (its work stands down; it is issued again)${a.note ? `: ${a.note}` : ''}`;
    }
    if (a.kind === 'rehearse') {
      const op = await this.record.requireActive('operation', a.operationId);
      return `Rehearse Operation ${op.body.name} on the sand table`;
    }
    if (a.kind === 'main-effort') {
      if (!a.operationId) return 'Clear the main effort';
      const op = await this.record.requireActive('operation', a.operationId);
      return `Make Operation ${op.body.name} the main effort`;
    }
    if (a.kind === 'stand-down' || a.kind === 'lift-stand-down') {
      const who =
        a.scope === 'all'
          ? 'all units'
          : a.scope === 'unit'
            ? (await this.record.requireActive('unit', a.targetId!)).body.name
            : (await this.record.requireActive('bot', a.targetId!)).body.callsign;
      return a.kind === 'stand-down' ? `Stand down ${who}` : `Resume work: ${who}`;
    }
    if (a.kind === 'restart-queues') return 'Restart the queues';
    const unit = await this.record.requireActive('unit', a.unitId);
    const u = unit.body.name;
    switch (a.kind) {
      case 'recon':
        return `Send ${u} on recon: “${a.question}”`;
      case 'take-issue':
        return `${u} takes on issue #${a.number}`;
      case 'budget-grant':
        return `Raise ${u}${u.endsWith('s') ? "'" : "'s"} compute budget by ${a.units} units`;
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
      case 'decide-permission': {
        const t = await this.record.requireActive('task', a.taskId);
        const what = t.body.permission?.action ?? 'its request';
        return `${a.approve ? 'Give' : 'Refuse'} task #${t.body.number} (${u}) permission: ${what}`;
      }
      case 'frago':
        return `${a.change === 'stand-down' ? 'Stand down' : 'Amend'} ${a.taskIds.length} task(s) in ${u}`;
      default:
        return `${a.kind} for ${u}`;
    }
  }
}
