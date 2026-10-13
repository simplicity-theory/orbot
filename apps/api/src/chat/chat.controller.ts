import { Authority } from '../officers/authority.js';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ChatChannel, ConfirmPendingRequest, SendChatRequest } from '@orbot/shared';
import { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ChatService } from './chat.service.js';

const Channel = new ZodPipe(ChatChannel);
const Uuid = new ParseUUIDPipe();
const OrdersQuery = z.object({ unitId: z.uuid().optional() });

/** Command by chat: talk to HQ or any Overseer; every change is read back and logged. */
@Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('chat/:channel')
  view(@Param('channel', Channel) channel: string) {
    return this.chat.view(channel);
  }

  @Authority({ level: 'read' })
  @Post('chat/:channel')
  send(
    @Param('channel', Channel) channel: string,
    @Body(new ZodPipe(SendChatRequest)) body: z.output<typeof SendChatRequest>,
    @Actor() actor: string,
  ) {
    return this.chat.send(channel, body.text, actor);
  }

  @Authority({ level: 'read' })
  @Post('pending/:id/confirm')
  @HttpCode(200)
  confirm(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(ConfirmPendingRequest)) body: z.output<typeof ConfirmPendingRequest>,
    @Actor() actor: string,
  ) {
    return this.chat.confirm(id, body.phrase, actor);
  }

  @Authority({ level: 'read' })
  @Post('pending/:id/decline')
  @HttpCode(200)
  decline(@Param('id', Uuid) id: string, @Actor() actor: string) {
    return this.chat.decline(id, actor);
  }

  @Get('orders')
  orders(@Query(new ZodPipe(OrdersQuery)) q: z.infer<typeof OrdersQuery>) {
    return this.chat.ordersLog(q);
  }

  @Authority({ level: 'read' })
  @Post('orders/:id/undo')
  @HttpCode(200)
  undo(@Param('id', Uuid) id: string, @Actor() actor: string) {
    return this.chat.undo(id, actor);
  }
}
