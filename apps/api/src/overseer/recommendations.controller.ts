import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { RecommendationDecisionRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ViewsService } from '../domain/views.service.js';
import { Authority } from '../officers/authority.js';
import { RecommendationsService } from './recommendations.service.js';

const Uuid = new ParseUUIDPipe();

/** HQ's recommendations (D130): the Commander's alone to take up or dismiss. */
@Controller()
export class RecommendationsController {
  constructor(
    private readonly recommendations: RecommendationsService,
    private readonly views: ViewsService,
  ) {}

  @Authority({ level: 'read' })
  @Get('recommendations')
  list() {
    return this.views.recommendations();
  }

  @Post('recommendations/:id/adopt')
  @HttpCode(200)
  async adopt(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(RecommendationDecisionRequest))
    body: z.output<typeof RecommendationDecisionRequest>,
    @Actor() actor: string,
  ) {
    await this.recommendations.adopt(id, actor, body.note);
    return this.views.recommendation(id);
  }

  @Post('recommendations/:id/dismiss')
  @HttpCode(200)
  async dismiss(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(RecommendationDecisionRequest))
    body: z.output<typeof RecommendationDecisionRequest>,
    @Actor() actor: string,
  ) {
    await this.recommendations.dismiss(id, body.note, actor);
    return this.views.recommendation(id);
  }
}
