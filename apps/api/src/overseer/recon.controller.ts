import { Authority, unitOf } from '../officers/authority.js';
import { Body, Controller, Post } from '@nestjs/common';
import { ReconRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { ReconService } from './recon.service.js';

/** Send a unit on recon: a read-only survey that files a report. */
@Controller('recon')
export class ReconController {
  constructor(private readonly recon: ReconService) {}

  @Authority({ level: 'unit', units: unitOf('unit', 'body') })
  @Post()
  async order(
    @Body(new ZodPipe(ReconRequest)) body: z.output<typeof ReconRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.recon.order(body, actor));
  }
}
