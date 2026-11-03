import { Injectable } from '@nestjs/common';
import type { NewProjectRequest, OperationBody, RecordVersion, SupplyBody } from '@orbot/shared';
import type { z } from 'zod';
import { HqService } from '../overseer/hq.service.js';
import type { WriteContext } from '../record/record.service.js';
import { SupplyService } from './supply.service.js';

export interface NewProject {
  repository: RecordVersion<SupplyBody>;
  site: RecordVersion<SupplyBody>;
  operation: RecordVersion<OperationBody> | null;
}

/**
 * A new project in one order: a repository from a template, a static site to deploy it to
 * (production tier, so the plan's deploy need is met), deploy rights if asked, and the
 * operation that builds it with both assigned. Each piece is an ordinary depot item afterwards.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly supply: SupplyService,
    private readonly hq: HqService,
  ) {}

  async start(input: z.output<typeof NewProjectRequest>, ctx: WriteContext): Promise<NewProject> {
    const repository = await this.supply.createRepository(
      { name: input.name, template: input.kind },
      { ...ctx, reason: `Project ${input.name} started` },
    );
    const site = await this.supply.connectEnvironment(
      { name: `${input.name} site`, tier: 'production', site: true },
      { ...ctx, reason: `Project ${input.name} started: its site` },
    );
    if (input.deployRightsUnitId) {
      await this.supply.allotToUnit(site.entityId, input.deployRightsUnitId, {
        ...ctx,
        reason: `Deploy rights to ${site.body.name}`,
      });
    }
    const operation = input.intent
      ? await this.hq.createOperation(
          input.intent,
          input.name,
          ctx.actor,
          input.budgetUnits,
          false,
          [repository.entityId, site.entityId],
        )
      : null;
    return { repository, site, operation };
  }
}
