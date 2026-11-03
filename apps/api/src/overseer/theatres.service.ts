import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type {
  CreateTheatreRequest,
  OperationBody,
  RecordVersion,
  SupplyBody,
  TheatreBody,
  TheatreIntentRequest,
} from '@orbot/shared';
import type { z } from 'zod';
import { RecordService, type WriteContext } from '../record/record.service.js';
import { SupplyService } from '../supply/supply.service.js';
import { HqService } from './hq.service.js';

export interface NewTheatre {
  theatre: RecordVersion<TheatreBody>;
  repository: RecordVersion<SupplyBody> | null;
  site: RecordVersion<SupplyBody> | null;
  operation: RecordVersion<OperationBody> | null;
}

/**
 * A theatre is a software project: the standing home of one codebase. It holds the repository
 * the work lands in, the site or environments it deploys to, and whatever else its operations
 * share, so every operation launched in it starts equipped and the Commander assigns a
 * repository once, not per operation (D121).
 */
@Injectable()
export class TheatresService {
  constructor(
    private readonly record: RecordService,
    private readonly supply: SupplyService,
    private readonly hq: HqService,
  ) {}

  list() {
    return this.record.listActive('theatre');
  }

  async require(id: string) {
    return this.record.requireActive('theatre', id);
  }

  /** Open a theatre: its repository (new from a template, an existing one, or none yet), its site if asked, and the first operation if an intent came with it. */
  async create(
    input: z.output<typeof CreateTheatreRequest>,
    ctx: WriteContext,
  ): Promise<NewTheatre> {
    const taken = (await this.list()).find(
      (t) => t.body.status === 'open' && t.body.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (taken) {
      throw new BadRequestException({
        message: `A theatre called ${taken.body.name} is already open.`,
        action: 'Choose another name, or launch the operation in that theatre.',
      });
    }
    let repository: RecordVersion<SupplyBody> | null = null;
    const repo = input.repository;
    if (repo?.kind === 'template') {
      repository = await this.supply.createRepository(
        { name: input.name, template: repo.template },
        { ...ctx, reason: `Theatre ${input.name} opened: its repository` },
      );
    } else if (repo?.kind === 'existing') {
      repository = await this.record.requireActive('supply', repo.supplyId);
      if (repository.body.spec.kind !== 'repository') {
        throw new BadRequestException({
          message: `${repository.body.name} is not a repository.`,
          action: 'Choose a repository from the Supply Depot.',
        });
      }
    } else if (repo?.kind === 'location') {
      repository = await this.supply.connectRepository(
        {
          name: input.name,
          location: repo.location,
          defaultBranch: repo.defaultBranch ?? undefined,
        },
        { ...ctx, reason: `Theatre ${input.name} opened: its repository` },
      );
    }
    const site = input.site
      ? await this.supply.connectEnvironment(
          { name: `${input.name} site`, tier: 'production', site: true },
          { ...ctx, reason: `Theatre ${input.name} opened: its site` },
        )
      : null;
    const extra: RecordVersion<SupplyBody>[] = [];
    for (const id of new Set(input.supplyIds ?? [])) {
      if (id === repository?.entityId || id === site?.entityId) continue;
      extra.push(await this.record.requireActive('supply', id));
    }
    const supplyIds = [
      ...(repository ? [repository.entityId] : []),
      ...(site ? [site.entityId] : []),
      ...extra.map((s) => s.entityId),
    ];
    const theatre = await this.record.create(
      'theatre',
      {
        name: input.name,
        description: input.description ?? '',
        status: 'open',
        supplyIds,
        repoSupplyId: repository?.entityId ?? null,
        holdPolicy: null,
        autonomy: input.autonomy,
        publish: input.autonomy === 'full' ? 'auto' : 'approved',
        closed: null,
      },
      { ...ctx, reason: `Theatre ${input.name} opened` },
    );
    await this.record.event(
      'sitrep',
      {
        level: 'hq',
        text: `Theatre ${input.name} opened${repository ? ` on ${repository.body.name}` : ' with no repository yet'}${site ? `, publishing to ${site.body.name}` : ''}.`,
        status: null,
      },
      {},
      ctx.actor,
    );
    const operation = input.intent
      ? await this.launch(
          theatre.entityId,
          { intent: input.intent, name: input.name, budgetUnits: input.budgetUnits ?? null },
          ctx.actor,
        )
      : null;
    return { theatre, repository, site, operation };
  }

  /** State intent inside a theatre: the operation starts with everything the theatre holds. */
  async launch(
    theatreId: string,
    input: z.output<typeof TheatreIntentRequest>,
    actor: string,
    opts: { campaignId?: string | null } = {},
  ) {
    const theatre = await this.require(theatreId);
    this.assertOpen(theatre, 'Launch an operation in');
    return this.hq.createOperation(
      input.intent,
      input.name ?? null,
      actor,
      input.budgetUnits ?? null,
      input.reconFirst ?? false,
      [...theatre.body.supplyIds, ...(input.supplyIds ?? [])],
      { ...TheatresService.launchOptions(theatre), campaignId: opts.campaignId ?? null },
    );
  }

  /** How an operation runs in this theatre: fully automatic, or waiting on the Commander. */
  static launchOptions(theatre: RecordVersion<TheatreBody>) {
    const full = theatre.body.autonomy === 'full';
    return {
      theatreId: theatre.entityId,
      autonomous: full,
      holdPolicy: full
        ? (theatre.body.holdPolicy ?? { holdFrom: 'never' as const, fixUpTo: 'large' as const })
        : theatre.body.holdPolicy,
    };
  }

  /** Give the theatre a depot item (every operation launched from now on starts with it). */
  async assign(theatreId: string, supplyId: string, ctx: WriteContext) {
    const theatre = await this.require(theatreId);
    this.assertOpen(theatre, 'Assign resources to');
    const s = await this.record.requireActive('supply', supplyId);
    if (theatre.body.supplyIds.includes(supplyId)) return theatre;
    return this.record.revise(
      'theatre',
      theatreId,
      (t) => ({
        ...t,
        supplyIds: [...t.supplyIds, supplyId],
        repoSupplyId:
          t.repoSupplyId ?? (s.body.spec.kind === 'repository' ? supplyId : t.repoSupplyId),
      }),
      { ...ctx, reason: ctx.reason || `${s.body.name} assigned to Theatre ${theatre.body.name}` },
    );
  }

  /** Take a depot item off the theatre. Operations already launched keep it. */
  async release(theatreId: string, supplyId: string, ctx: WriteContext) {
    const theatre = await this.require(theatreId);
    const s = await this.record.requireActive('supply', supplyId);
    return this.record.revise(
      'theatre',
      theatreId,
      (t) => ({
        ...t,
        supplyIds: t.supplyIds.filter((id) => id !== supplyId),
        repoSupplyId: t.repoSupplyId === supplyId ? null : t.repoSupplyId,
      }),
      { ...ctx, reason: ctx.reason || `${s.body.name} taken off Theatre ${theatre.body.name}` },
    );
  }

  /** Make a repository the one the theatre's operations work in. */
  async setMainRepository(theatreId: string, supplyId: string, ctx: WriteContext) {
    const theatre = await this.require(theatreId);
    this.assertOpen(theatre, 'Change the repository of');
    const s = await this.record.requireActive('supply', supplyId);
    if (s.body.spec.kind !== 'repository') {
      throw new BadRequestException({
        message: `${s.body.name} is not a repository.`,
        action: 'Choose a repository from the Supply Depot.',
      });
    }
    return this.record.revise(
      'theatre',
      theatreId,
      (t) => ({
        ...t,
        repoSupplyId: supplyId,
        supplyIds: [supplyId, ...t.supplyIds.filter((id) => id !== supplyId)],
      }),
      { ...ctx, reason: `${s.body.name} is now the repository of Theatre ${theatre.body.name}` },
    );
  }

  /** Close the theatre: its operations must be over first. */
  async close(theatreId: string, note: string, actor: string) {
    const theatre = await this.require(theatreId);
    this.assertOpen(theatre, 'Close');
    const campaigns = (
      await this.record.listActive('campaign', { bodyContains: { theatreId } })
    ).filter((c) => c.body.status === 'under-way' || c.body.status === 'held');
    if (campaigns.length) {
      throw new ConflictException({
        message: `Theatre ${theatre.body.name} still has ${campaigns.length} campaign(s) under way: ${campaigns.map((c) => c.body.name).join(', ')}.`,
        action: 'Let them finish, or call them off, then close the theatre.',
      });
    }
    const open = (
      await this.record.listActive('operation', { bodyContains: { theatreId } })
    ).filter((o) => o.body.phase !== 'closed');
    if (open.length) {
      throw new ConflictException({
        message: `Theatre ${theatre.body.name} still has ${open.length} operation(s) under way: ${open.map((o) => o.body.name).join(', ')}.`,
        action: 'Let them close, or cancel them, then close the theatre.',
      });
    }
    const closed = await this.record.revise(
      'theatre',
      theatreId,
      (t) => ({
        ...t,
        status: 'closed',
        closed: { by: actor, note, at: new Date().toISOString() },
      }),
      { actor, reason: note ? `Closed: ${note}` : 'Closed' },
    );
    await this.record.event(
      'sitrep',
      {
        level: 'hq',
        text: `Theatre ${theatre.body.name} closed${note ? `: ${note}` : ''}. Its record stays.`,
        status: null,
      },
      {},
      actor,
    );
    return closed;
  }

  private assertOpen(theatre: RecordVersion<TheatreBody>, what: string) {
    if (theatre.body.status === 'closed') {
      throw new BadRequestException({
        message: `Theatre ${theatre.body.name} is closed.`,
        action: `${what} a theatre that is open; open a new one for new work.`,
      });
    }
  }
}
