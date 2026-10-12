import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CreateOperationRequest, DeployDecisionRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { ViewsService } from '../domain/views.service.js';
import { HqService } from './hq.service.js';
import { OverseerService } from './overseer.service.js';

const Uuid = new ParseUUIDPipe();

/** Operations: from the Commander's intent, through HQ, across the units. */
@Controller()
export class OperationsController {
  constructor(
    private readonly hq: HqService,
    private readonly overseer: OverseerService,
    private readonly views: ViewsService,
  ) {}

  @Get('operations')
  list() {
    return this.views.operations();
  }

  @Get('operations/:id')
  detail(@Param('id', Uuid) id: string) {
    return this.views.operation(id);
  }

  @Post('operations')
  async create(
    @Body(new ZodPipe(CreateOperationRequest)) body: z.output<typeof CreateOperationRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.hq.createOperation(body.intent, body.name ?? null, actor));
  }

  /** Approve (or reject) a production deploy waiting on the Commander. */
  @Post('tasks/:id/deploy-decision')
  @HttpCode(200)
  async decide(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(DeployDecisionRequest)) body: z.output<typeof DeployDecisionRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.overseer.decideDeploy(id, body.approve, body.note, actor));
  }
}
