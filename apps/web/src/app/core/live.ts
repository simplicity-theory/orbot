import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { io, type Socket } from 'socket.io-client';
import { debounceTime, filter, Subject } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { RecordEvent, RecordVersion } from '@orbot/shared';

export type LiveNotification =
  { type: 'version'; version: RecordVersion } | { type: 'event'; event: RecordEvent };

/** Live record feed over Socket.IO. Pages subscribe and refresh what they show. */
@Injectable({ providedIn: 'root' })
export class Live {
  readonly connected = signal(false);
  readonly notifications$ = new Subject<LiveNotification>();
  private socket: Socket | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.disconnect());
  }

  connect(): void {
    if (this.socket) return;
    this.socket = io({ path: '/api/ws', withCredentials: true, transports: ['websocket'] });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('record', (n: LiveNotification) => this.notifications$.next(n));
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
    this.connected.set(false);
  }
}

/** Ids touched by a notification, for cheap "does this concern me?" checks. */
export function touchedIds(n: LiveNotification): string[] {
  if (n.type === 'version') {
    const b = n.version.body as Record<string, unknown>;
    return [n.version.entityId, n.version.unitId, b['botId'], b['unitId'], b['taskId']].filter(
      (x): x is string => typeof x === 'string',
    );
  }
  const e = n.event;
  return [e.unitId, e.botId, e.taskId, e.operationId, e.missionId].filter((x): x is string => !!x);
}

/**
 * Re-run `reload` (debounced) whenever a committed record write matches `concerns`.
 * Call from an injection context (component constructor / field initialiser).
 */
export function reloadOnLive(
  concerns: (n: LiveNotification) => boolean,
  reload: () => void,
  debounceMs = 150,
): void {
  inject(Live)
    .notifications$.pipe(filter(concerns), debounceTime(debounceMs), takeUntilDestroyed())
    .subscribe(() => reload());
}
