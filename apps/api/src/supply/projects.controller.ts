import { Body, Controller, Post } from '@nestjs/common';
import { NewProjectRequest, type NewProjectView } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { ProjectsService } from './projects.service.js';

/** Start a new project. The Commander's alone: it connects supply and launches an operation. */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  async start(
    @Body(new ZodPipe(NewProjectRequest)) body: z.output<typeof NewProjectRequest>,
    @Actor() actor: string,
  ): Promise<NewProjectView> {
    const r = await this.projects.start(body, { actor, reason: `Project ${body.name} started` });
    return {
      theatre: toView(r.theatre),
      repository: toView(r.repository),
      site: toView(r.site),
      operation: r.operation ? toView(r.operation) : null,
    };
  }
}
