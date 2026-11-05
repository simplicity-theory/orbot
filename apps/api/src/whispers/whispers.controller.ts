import { Body, Controller, Get, Post } from '@nestjs/common';
import { WhisperRequest } from '@orbot/shared';
import type { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { Authority } from '../officers/authority.js';
import { WhispersService } from './whispers.service.js';

/** The whispers board: anyone signed in reads it and leaves notes; nothing is recorded. */
@Controller()
export class WhispersController {
  constructor(private readonly whispers: WhispersService) {}

  @Authority({ level: 'read' })
  @Get('whispers')
  board() {
    return this.whispers.board();
  }

  @Authority({ level: 'read' })
  @Post('whispers')
  leave(@Body(new ZodPipe(WhisperRequest)) body: z.output<typeof WhisperRequest>) {
    return this.whispers.leave(body.text);
  }
}
