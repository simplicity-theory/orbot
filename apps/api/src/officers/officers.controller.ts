import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  actorRef,
  AppointOfficerRequest,
  ResetPasswordRequest,
  UpdateOfficerRequest,
  type Principal,
} from '@orbot/shared';
import type { z } from 'zod';
import { Actor, CurrentPrincipal } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView, toViews } from '../domain/view.js';
import { Authority, AuthorityService } from './authority.js';
import { OfficersService } from './officers.service.js';

const Uuid = new ParseUUIDPipe();

/** Officers: appointed, re-ranked and retired by the Commander. Passwords are write-only. */
@Controller('officers')
export class OfficersController {
  constructor(
    private readonly officers: OfficersService,
    private readonly authority: AuthorityService,
  ) {}

  @Get()
  async list() {
    return toViews(await this.officers.list());
  }

  @Post()
  async appoint(
    @Body(new ZodPipe(AppointOfficerRequest)) body: z.output<typeof AppointOfficerRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.officers.appoint(body, actor));
  }

  @Put(':id')
  async update(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(UpdateOfficerRequest)) body: z.output<typeof UpdateOfficerRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.officers.update(id, body, actor));
  }

  /** The Commander resets anyone's password; an officer may change their own. */
  @Post(':id/password')
  @HttpCode(204)
  @Authority({ level: 'read' })
  async password(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(ResetPasswordRequest)) body: z.output<typeof ResetPasswordRequest>,
    @CurrentPrincipal() p: Principal,
  ) {
    const actor = actorRef(p);
    if (!(p.kind === 'officer' && p.id === id)) await this.authority.require(actor, null);
    await this.officers.resetPassword(id, body.password, actor);
  }
}
