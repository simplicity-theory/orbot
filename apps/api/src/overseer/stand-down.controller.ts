import { Authority, standDownUnits } from '../officers/authority.js';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { StandDownRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { StandDownService } from './stand-down.service.js';

type Req = z.output<typeof StandDownRequest>;

/** Stand down a bot, a unit or everything; resume work when the order is lifted. */
@Controller('stand-down')
export class StandDownController {
  constructor(private readonly standDown: StandDownService) {}

  @Get()
  view() {
    return this.standDown.view();
  }

  @Authority({ level: 'unit', units: standDownUnits })
  @Post()
  @HttpCode(200)
  async order(@Body(new ZodPipe(StandDownRequest)) body: Req, @Actor() actor: string) {
    await this.standDown.standDown(body, body.reason, actor);
    return this.standDown.view();
  }

  @Authority({ level: 'unit', units: standDownUnits })
  @Post('lift')
  @HttpCode(200)
  async lift(@Body(new ZodPipe(StandDownRequest)) body: Req, @Actor() actor: string) {
    await this.standDown.lift(body, body.reason, actor);
    return this.standDown.view();
  }
}
