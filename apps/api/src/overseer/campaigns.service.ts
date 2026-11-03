import {
  BadRequestException,
  ConflictException,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type {
  CampaignBody,
  CreateCampaignRequest,
  OperationBody,
  RecordVersion,
} from '@orbot/shared';
import type { Subscription } from 'rxjs';
import type { z } from 'zod';
import { Background } from '../common/background.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService, type WriteContext } from '../record/record.service.js';
import { HqService } from './hq.service.js';
import { HQ_ACTOR } from './overseers.js';
import { TheatresService } from './theatres.service.js';

/**
 * A campaign is a sequence of operations toward one end, inside a theatre (D126). The Commander
 * plans the steps once; HQ launches each as an operation when the one before it closes. A step
 * whose operation is cancelled holds the campaign: the Commander starts the step over, skips it,
 * or calls the campaign off. Nothing in it waits for the Commander otherwise.
 */
@Injectable()
export class CampaignsService implements OnApplicationBootstrap, OnModuleDestroy {
  private sub: Subscription | null = null;

  constructor(
    private readonly record: RecordService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly theatres: TheatresService,
    private readonly hq: HqService,
  ) {}

  onApplicationBootstrap(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type !== 'version' || n.version.entityType !== 'operation') return;
      const b = n.version.body as OperationBody;
      if (!b.campaignId || b.phase !== 'closed') return;
      const id = b.campaignId;
      this.background.run(`campaign:${id}`, 'advance', () => this.advance(id, n.version.entityId));
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  list() {
    return this.record.listActive('campaign');
  }

  require(id: string) {
    return this.record.requireActive('campaign', id);
  }

  /** Plan the campaign and launch its first step. */
  async create(
    theatreId: string,
    input: z.output<typeof CreateCampaignRequest>,
    ctx: WriteContext,
  ): Promise<RecordVersion<CampaignBody>> {
    const theatre = await this.theatres.require(theatreId);
    if (theatre.body.status === 'closed') {
      throw new BadRequestException({
        message: `Theatre ${theatre.body.name} is closed.`,
        action: 'Plan the campaign in a theatre that is open.',
      });
    }
    const steps = input.steps.map((s, i) => ({
      name: s.name ?? stepName(s.intent, i),
      intent: s.intent,
      operationId: null,
    }));
    const campaign = await this.record.create(
      'campaign',
      {
        theatreId,
        name: input.name,
        description: input.description,
        status: 'under-way',
        steps,
        current: 0,
        held: null,
        closed: null,
      },
      { ...ctx, reason: ctx.reason || `Campaign ${input.name} planned` },
    );
    await this.sitrep(
      `Campaign ${input.name} planned in Theatre ${theatre.body.name}: ${steps.length} step(s), ${steps.map((s, i) => `${i + 1}. ${s.name}`).join('; ')}.`,
      ctx.actor,
    );
    return this.launchStep(campaign.entityId, ctx.actor);
  }

  /** Launch the current step as an operation in the theatre, with everything it holds. */
  private async launchStep(id: string, actor: string): Promise<RecordVersion<CampaignBody>> {
    const c = await this.require(id);
    const step = c.body.steps[c.body.current];
    if (!step) return c;
    const op = await this.theatres.launch(
      c.body.theatreId,
      { intent: step.intent, name: step.name },
      actor,
      { campaignId: id },
    );
    const revised = await this.record.revise(
      'campaign',
      id,
      (b) => ({
        ...b,
        status: 'under-way',
        held: null,
        steps: b.steps.map((s, i) => (i === b.current ? { ...s, operationId: op.entityId } : s)),
      }),
      { actor: HQ_ACTOR, reason: `Step ${c.body.current + 1} of ${c.body.steps.length} launched` },
    );
    await this.sitrep(
      `Campaign ${c.body.name}: step ${c.body.current + 1} of ${c.body.steps.length} launched as Operation ${op.body.name}.`,
      HQ_ACTOR,
      op.entityId,
    );
    return revised;
  }

  /** An operation of the campaign closed: the next step launches, or the campaign holds or ends. */
  private async advance(id: string, opId: string): Promise<void> {
    const c = await this.record.getActive('campaign', id);
    if (!c || c.body.status !== 'under-way') return;
    const step = c.body.steps[c.body.current];
    if (!step || step.operationId !== opId) return;
    const op = await this.record.requireActive('operation', opId);
    if (op.body.cancelled) {
      const why = `Operation ${op.body.name} (step ${c.body.current + 1}) was cancelled${op.body.cancelled.note ? `: ${op.body.cancelled.note}` : ''}`;
      await this.record.revise('campaign', id, (b) => ({ ...b, status: 'held', held: why }), {
        actor: HQ_ACTOR,
        reason: 'Held: its operation was cancelled',
      });
      await this.sitrep(
        `Campaign ${c.body.name} holds: ${why}. Start the step over, skip it, or call the campaign off.`,
        HQ_ACTOR,
        opId,
      );
      return;
    }
    const next = c.body.current + 1;
    if (next >= c.body.steps.length) {
      await this.record.revise(
        'campaign',
        id,
        (b) => ({
          ...b,
          status: 'done',
          current: next,
          closed: { by: HQ_ACTOR, note: 'Every step done', at: new Date().toISOString() },
        }),
        { actor: HQ_ACTOR, reason: 'Every step done' },
      );
      await this.sitrep(
        `Campaign ${c.body.name} complete: all ${c.body.steps.length} step(s) done.`,
        HQ_ACTOR,
        opId,
      );
      return;
    }
    await this.record.revise('campaign', id, (b) => ({ ...b, current: next }), {
      actor: HQ_ACTOR,
      reason: `Step ${c.body.current + 1} done`,
    });
    await this.launchStep(id, HQ_ACTOR);
  }

  /** A held campaign goes on: the step is started over as a new operation, or skipped. */
  async resume(id: string, skip: boolean, actor: string): Promise<RecordVersion<CampaignBody>> {
    const c = await this.require(id);
    if (c.body.status !== 'held') {
      throw new ConflictException({
        message: `Campaign ${c.body.name} is ${c.body.status === 'under-way' ? 'under way' : c.body.status}.`,
        action:
          c.body.status === 'under-way'
            ? 'It is not held; nothing to resume.'
            : 'Plan a new campaign for more work.',
      });
    }
    if (skip) {
      const next = c.body.current + 1;
      if (next >= c.body.steps.length) {
        const done = await this.record.revise(
          'campaign',
          id,
          (b) => ({
            ...b,
            status: 'done',
            held: null,
            current: next,
            closed: { by: actor, note: 'Last step skipped', at: new Date().toISOString() },
          }),
          { actor, reason: 'Last step skipped' },
        );
        await this.sitrep(`Campaign ${c.body.name} complete: its last step was skipped.`, actor);
        return done;
      }
      await this.record.revise('campaign', id, (b) => ({ ...b, current: next, held: null }), {
        actor,
        reason: `Step ${c.body.current + 1} skipped`,
      });
      await this.sitrep(`Campaign ${c.body.name}: step ${c.body.current + 1} skipped.`, actor);
    }
    return this.launchStep(id, actor);
  }

  /** Call the campaign off: its operation under way is cancelled too. */
  async cancel(id: string, note: string, actor: string): Promise<RecordVersion<CampaignBody>> {
    const c = await this.require(id);
    if (c.body.status === 'done' || c.body.status === 'cancelled') {
      throw new ConflictException({
        message: `Campaign ${c.body.name} is already ${c.body.status}.`,
        action: 'Plan a new campaign for more work.',
      });
    }
    // Mark it first so the operation's closing does not hold or advance it.
    const cancelled = await this.record.revise(
      'campaign',
      id,
      (b) => ({
        ...b,
        status: 'cancelled',
        held: null,
        closed: { by: actor, note, at: new Date().toISOString() },
      }),
      { actor, reason: note ? `Called off: ${note}` : 'Called off' },
    );
    const step = c.body.steps[c.body.current];
    if (step?.operationId) {
      const op = await this.record.getActive('operation', step.operationId);
      if (op && op.body.phase !== 'closed') {
        await this.hq.cancelOperation(
          step.operationId,
          `Campaign ${c.body.name} called off${note ? `: ${note}` : ''}`,
          actor,
        );
      }
    }
    await this.sitrep(
      `Campaign ${c.body.name} called off${note ? `: ${note}` : ''}. ${c.body.current} of ${c.body.steps.length} step(s) were done.`,
      actor,
    );
    return cancelled;
  }

  private sitrep(text: string, actor: string, operationId: string | null = null) {
    return this.record.event(
      'sitrep',
      { level: 'hq', text, status: null },
      operationId ? { operationId } : {},
      actor,
    );
  }
}

/** A step's name when none was given: the first few words of its intent. */
function stepName(intent: string, i: number): string {
  const words = intent
    .replace(/[.!?]+$/, '')
    .split(/\s+/)
    .slice(0, 5)
    .join(' ');
  return words || `Step ${i + 1}`;
}
