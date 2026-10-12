import { Inject, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Subscription } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { cookieValue, SESSION_COOKIE, verifySession } from '../auth/session.js';
import { RecordBus } from '../record/record-bus.js';
import { RedactionService } from '../redaction/redaction.service.js';

export const WS_RECORD_EVENT = 'record';

/**
 * Live feed of committed record writes (status changes, sitreps, diary entries…).
 * Only signed-in clients may connect; every payload is redacted before emit.
 */
@WebSocketGateway({ path: '/api/ws', cors: { origin: true, credentials: true } })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private sub: Subscription | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly bus: RecordBus,
    private readonly redaction: RedactionService,
  ) {}

  afterInit(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      this.server.emit(WS_RECORD_EVENT, this.redaction.clean(n));
    });
  }

  handleConnection(client: Socket): void {
    const token = cookieValue(client.handshake.headers.cookie, SESSION_COOKIE);
    if (!verifySession(this.config.sessionSecret, token)) {
      client.emit('error', { code: 'unauthenticated', message: 'You are not signed in.', action: 'Sign in to continue.' });
      client.disconnect(true);
    }
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }
}
