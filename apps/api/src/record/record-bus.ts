import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { RecordEvent, RecordVersion } from '@orbot/shared';

export type RecordNotification =
  | { type: 'version'; version: RecordVersion }
  | { type: 'event'; event: RecordEvent };

/** Fan-out of committed record writes (to the WebSocket gateway and in-process listeners). */
@Injectable()
export class RecordBus {
  readonly notifications$ = new Subject<RecordNotification>();

  publish(n: RecordNotification): void {
    this.notifications$.next(n);
  }
}
