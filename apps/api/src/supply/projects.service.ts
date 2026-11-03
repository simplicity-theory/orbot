import { Injectable } from '@nestjs/common';
import type { NewProjectRequest } from '@orbot/shared';
import type { z } from 'zod';
import { TheatresService, type NewTheatre } from '../overseer/theatres.service.js';
import type { WriteContext } from '../record/record.service.js';

/**
 * A new project in one order: a theatre with a repository from a template, a static site to
 * deploy it to (production tier, so the plan's deploy need is met), and the first operation if
 * an intent came with it (D104, D121).
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly theatres: TheatresService) {}

  async start(
    input: z.output<typeof NewProjectRequest>,
    ctx: WriteContext,
  ): Promise<
    NewTheatre & {
      repository: NonNullable<NewTheatre['repository']>;
      site: NonNullable<NewTheatre['site']>;
    }
  > {
    const t = await this.theatres.create(
      {
        name: input.name,
        description: '',
        repository: { kind: 'template', template: input.kind },
        site: true,
        supplyIds: [],
        intent: input.intent,
        budgetUnits: input.budgetUnits,
      },
      ctx,
    );
    return { ...t, repository: t.repository!, site: t.site! };
  }
}
