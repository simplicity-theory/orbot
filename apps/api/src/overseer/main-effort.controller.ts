import { Body, Controller, Get, Put } from '@nestjs/common';
import { SetMainEffortRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MainEffortService } from './main-effort.service.js';

/** Name the operation the force puts first, or clear it. */
@Controller('main-effort')
export class MainEffortController {
  constructor(private readonly mainEffort: MainEffortService) {}

  @Get()
  view() {
    return this.mainEffort.view();
  }

  @Put()
  async set(
    @Body(new ZodPipe(SetMainEffortRequest)) body: z.output<typeof SetMainEffortRequest>,
    @Actor() actor: string,
  ) {
    await this.mainEffort.set(body.operationId, body.reason, actor);
    return this.mainEffort.view();
  }
}
