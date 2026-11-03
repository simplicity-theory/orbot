import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CreateCampaignRequest, CourseNoteRequest } from '@orbot/shared';
import { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ViewsService } from '../domain/views.service.js';
import { Authority } from '../officers/authority.js';
import { CampaignsService } from './campaigns.service.js';

const Uuid = new ParseUUIDPipe();
const ResumeRequest = z.object({ skip: z.boolean().default(false) });

/** Campaigns: sequences of operations inside a theatre. The Commander's alone to change. */
@Controller()
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly views: ViewsService,
  ) {}

  @Authority({ level: 'read' })
  @Get('campaigns')
  list() {
    return this.views.campaigns();
  }

  @Authority({ level: 'read' })
  @Get('campaigns/:id')
  one(@Param('id', Uuid) id: string) {
    return this.views.campaign(id);
  }

  @Post('theatres/:id/campaigns')
  async create(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(CreateCampaignRequest)) body: z.output<typeof CreateCampaignRequest>,
    @Actor() actor: string,
  ) {
    const c = await this.campaigns.create(id, body, {
      actor,
      reason: `Campaign ${body.name} planned`,
    });
    return this.views.campaign(c.entityId);
  }

  @Post('campaigns/:id/resume')
  @HttpCode(200)
  async resume(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(ResumeRequest)) body: z.output<typeof ResumeRequest>,
    @Actor() actor: string,
  ) {
    await this.campaigns.resume(id, body.skip, actor);
    return this.views.campaign(id);
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(CourseNoteRequest)) body: z.output<typeof CourseNoteRequest>,
    @Actor() actor: string,
  ) {
    await this.campaigns.cancel(id, body.note, actor);
    return this.views.campaign(id);
  }
}
