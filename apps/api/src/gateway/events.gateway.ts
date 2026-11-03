import { Inject, type OnModuleDestroy } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Subscription } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { cookieValue, SESSION_COOKIE, verifySession } from '../auth/session.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService } from '../record/record.service.js';
import { RedactionService } from '../redaction/redaction.service.js';

export const WS_RECORD_EVENT = 'record';

/**
 * Live feed of committed record writes (status changes, sitreps, diary entries…).
 * Only signed-in clients may connect; every payload is redacted before emit. CORS is set by
 * the adapter in `bootstrap.ts` (the configured web origin only).
 */
@WebSocketGateway({ path: '/api/ws' })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private sub: Subscription | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly bus: RecordBus,
    private readonly redaction: RedactionService,
    private readonly record: RecordService,
  ) {}

  afterInit(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      this.server.emit(WS_RECORD_EVENT, this.redaction.clean(n));
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = cookieValue(client.handshake.headers.cookie, SESSION_COOKIE);
    const p = verifySession(this.config.sessionSecret, token);
    // A retired officer's session ends at once, here as on every request.
    const retired =
      p?.kind === 'officer' &&
      !((await this.record.getActive('officer', p.id))?.body.retired === false);
    if (!p || retired) {
      client.emit('error', {
        code: 'unauthenticated',
        message: 'You are not signed in.',
        action: 'Sign in to continue.',
      });
      client.disconnect(true);
    }
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }
}
