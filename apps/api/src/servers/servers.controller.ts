import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ConnectServerRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { ServersService } from './servers.service.js';

/** Servers bots log in to. Connecting one is the Commander's (like all supply). */
@Controller('supply/servers')
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  @Post()
  async connect(
    @Body(new ZodPipe(ConnectServerRequest)) body: z.output<typeof ConnectServerRequest>,
    @Actor() actor: string,
  ) {
    return toView(
      await this.servers.connect(body, {
        actor,
        reason: `Server ${body.name} (${body.user}@${body.host}) connected`,
      }),
    );
  }

  /** Log in again with the stored key. */
  @Post(':id/check')
  @HttpCode(200)
  check(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.servers.check(id);
  }
}
