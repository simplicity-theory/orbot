import { Authority, escalationUnits } from '../officers/authority.js';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ResolveEscalationRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { EscalationService } from './escalation.service.js';

/** Stuck work that reached the Commander, and acknowledging it. */
@Controller('escalations')
export class EscalationController {
  constructor(private readonly escalations: EscalationService) {}

  @Get()
  open() {
    return this.escalations.openChains();
  }

  @Authority({ level: 'unit', units: escalationUnits })
  @Post(':chainId/resolve')
  @HttpCode(200)
  resolve(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body(new ZodPipe(ResolveEscalationRequest)) body: z.output<typeof ResolveEscalationRequest>,
    @Actor() actor: string,
  ) {
    return this.escalations.resolve(chainId, body.note, actor);
  }
}
