import {
  ConflictException,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { RecordEvent, RecordVersion, RecommendationBody } from '@orbot/shared';
import type { Subscription } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { Background } from '../common/background.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService } from '../record/record.service.js';
import { HQ_ACTOR } from './overseers.js';
import { TheatresService } from './theatres.service.js';

/**
 * What HQ recommends after an After Action review, because it came up before in the theatre
 * (D130): a rule two reviews drew, or a fix for a finding two operations left open. Lessons
 * stay recorded (D124); only what repeats reaches the Commander, as one line with one button,
 * never as a stop. Taken up, a rule becomes a standing order of the unit and a fix becomes an
 * operation in the theatre; dismissed, it stays on the record and is not raised again.
 */
@Injectable()
export class RecommendationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private sub: Subscription | null = null;

  constructor(
    private readonly record: RecordService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly theatres: TheatresService,
  ) {}

  onApplicationBootstrap(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type !== 'event' || n.event.kind !== 'after-action' || !n.event.operationId) return;
      const e = n.event as RecordEvent<'after-action'>;
      if (!e.body.recommendations.length) return;
      this.background.run('recommendations', 'after-action', () => this.fromReview(e));
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  list(status?: RecommendationBody['status']) {
    return this.record.listActive('recommendation', status ? { bodyContains: { status } } : {});
  }

  require(id: string) {
    return this.record.requireActive('recommendation', id);
  }

  /** Record what the review recommends; the same text already open in the theatre gains the operation. */
  private async fromReview(e: RecordEvent<'after-action'>): Promise<void> {
    const op = await this.record.getActive('operation', e.operationId!);
    if (!op?.body.theatreId) return;
    const theatreId = op.body.theatreId;
    const all = await this.record.listActive('recommendation', { bodyContains: { theatreId } });
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    for (const r of e.body.recommendations) {
      const existing = all.find((x) => x.body.kind === r.kind && same(x.body.text, r.text));
      if (existing) {
        // Decided already (taken up or dismissed): the Commander has spoken; it is not raised again.
        if (existing.body.status === 'open' && !existing.body.operationIds.includes(op.entityId))
          await this.record.revise(
            'recommendation',
            existing.entityId,
            (b) => ({ ...b, operationIds: [...b.operationIds, op.entityId], why: r.why }),
            { actor: HQ_ACTOR, reason: `Raised again by Operation ${op.body.name}` },
          );
        continue;
      }
      const made = await this.record.create(
        'recommendation',
        {
          theatreId,
          kind: r.kind,
          unitId: r.unitId,
          text: r.text,
          why: r.why,
          operationIds: [op.entityId],
        },
        { actor: HQ_ACTOR, reason: `After Action review of Operation ${op.body.name}` },
      );
      await this.record.event(
        'sitrep',
        {
          level: 'hq',
          text: `HQ recommends ${r.kind === 'rule' ? 'a rule' : 'a fix'}: ${r.text} (${r.why}) Take it up or dismiss it under Needs you.`,
          status: null,
        },
        { operationId: op.entityId },
        HQ_ACTOR,
      );
      all.push(made);
    }
  }

  /** Take it up: a rule becomes a standing order, a fix an operation in the theatre. */
  async adopt(id: string, actor: string, note = ''): Promise<RecordVersion<RecommendationBody>> {
    const r = await this.require(id);
    this.assertOpen(r);
    let operationId: string | null = null;
    if (r.body.kind === 'rule') {
      const units = r.body.unitId
        ? [await this.record.requireActive('unit', r.body.unitId)]
        : await this.record.listActive('unit');
      for (const u of units) {
        if (u.body.standingOrders.some((o) => o.text === r.body.text)) continue;
        await this.record.revise(
          'unit',
          u.entityId,
          (b) => ({
            ...b,
            standingOrders: [
              ...b.standingOrders,
              { id: `so-${randomUUID().slice(0, 8)}`, text: r.body.text },
            ],
          }),
          { actor, reason: `HQ's recommendation taken up${note ? `: ${note}` : ''}` },
        );
      }
    } else {
      const op = await this.theatres.launch(
        r.body.theatreId,
        { intent: r.body.text, name: fixOperationName(r.body.text) },
        actor,
      );
      operationId = op.entityId;
    }
    return this.record.revise(
      'recommendation',
      id,
      (b) => ({
        ...b,
        status: 'adopted',
        closed: { by: actor, note, at: new Date().toISOString(), operationId },
      }),
      { actor, reason: 'Taken up' },
    );
  }

  async dismiss(
    id: string,
    note: string,
    actor: string,
  ): Promise<RecordVersion<RecommendationBody>> {
    const r = await this.require(id);
    this.assertOpen(r);
    return this.record.revise(
      'recommendation',
      id,
      (b) => ({
        ...b,
        status: 'dismissed',
        closed: { by: actor, note, at: new Date().toISOString(), operationId: null },
      }),
      { actor, reason: `Dismissed${note ? `: ${note}` : ''}` },
    );
  }

  private assertOpen(r: RecordVersion<RecommendationBody>) {
    if (r.body.status !== 'open')
      throw new ConflictException({
        message: `That recommendation was already ${r.body.status}.`,
        action: 'Nothing to do; it stays on the record.',
      });
  }
}

/** An operation name for a fix: the first words of what to fix. */
export function fixOperationName(text: string): string {
  const words = text
    .replace(/^fix(?:\s*:)?\s+/i, '')
    .replace(/[.!]+$/, '')
    .split(/\s+/)
    .slice(0, 6)
    .join(' ');
  return `Fix: ${words}`;
}
