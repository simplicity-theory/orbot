import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  CancelOperationRequest,
  CreateTheatreRequest,
  OperationResourceRequest,
  TheatreIntentRequest,
  type NewTheatreView,
} from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { ViewsService } from '../domain/views.service.js';
import { Authority } from '../officers/authority.js';
import { TheatresService } from './theatres.service.js';

const Uuid = new ParseUUIDPipe();

/** Theatres: one per software project; operations are launched inside them. The Commander's alone to change. */
@Controller('theatres')
export class TheatresController {
  constructor(
    private readonly theatres: TheatresService,
    private readonly views: ViewsService,
  ) {}

  @Authority({ level: 'read' })
  @Get()
  list() {
    return this.views.theatres();
  }

  @Authority({ level: 'read' })
  @Get(':id')
  one(@Param('id', Uuid) id: string) {
    return this.views.theatre(id);
  }

  @Post()
  async create(
    @Body(new ZodPipe(CreateTheatreRequest)) body: z.output<typeof CreateTheatreRequest>,
    @Actor() actor: string,
  ): Promise<NewTheatreView> {
    const r = await this.theatres.create(body, { actor, reason: `Theatre ${body.name} opened` });
    return {
      theatre: toView(r.theatre),
      repository: r.repository ? toView(r.repository) : null,
      site: r.site ? toView(r.site) : null,
      operation: r.operation ? toView(r.operation) : null,
    };
  }

  /** State intent in this theatre: the operation starts with everything the theatre holds. */
  @Post(':id/operations')
  async launch(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(TheatreIntentRequest)) body: z.output<typeof TheatreIntentRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.theatres.launch(id, body, actor));
  }

  @Post(':id/resources')
  async assign(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(OperationResourceRequest)) body: z.output<typeof OperationResourceRequest>,
    @Actor() actor: string,
  ) {
    await this.theatres.assign(id, body.supplyId, { actor, reason: body.reason ?? '' });
    return this.views.theatre(id);
  }

  @Post(':id/resources/release')
  @HttpCode(200)
  async release(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(OperationResourceRequest)) body: z.output<typeof OperationResourceRequest>,
    @Actor() actor: string,
  ) {
    await this.theatres.release(id, body.supplyId, { actor, reason: body.reason ?? '' });
    return this.views.theatre(id);
  }

  @Post(':id/resources/main')
  @HttpCode(200)
  async main(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(OperationResourceRequest)) body: z.output<typeof OperationResourceRequest>,
    @Actor() actor: string,
  ) {
    await this.theatres.setMainRepository(id, body.supplyId, { actor, reason: body.reason ?? '' });
    return this.views.theatre(id);
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(CancelOperationRequest)) body: z.output<typeof CancelOperationRequest>,
    @Actor() actor: string,
  ) {
    await this.theatres.close(id, body.note, actor);
    return this.views.theatre(id);
  }
}
