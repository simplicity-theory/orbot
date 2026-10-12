import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { RuleDisputeRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { DisputeService } from './dispute.service.js';

/** Disputes between units: HQ's rulings, and the Commander's final say. */
@Controller('disputes')
export class DisputeController {
  constructor(private readonly disputes: DisputeService) {}

  @Get()
  list() {
    return this.disputes.list();
  }

  @Post(':id/rule')
  @HttpCode(200)
  async rule(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(RuleDisputeRequest)) body: z.output<typeof RuleDisputeRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.disputes.rule(id, body.prevails, body.reasoning, actor));
  }
}
