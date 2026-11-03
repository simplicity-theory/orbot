import { httpResource } from '@angular/common/http';
import { computed, Injectable } from '@angular/core';
import type { ApprovalsView } from '@orbot/shared';
import { apiUrl } from './api';
import { reloadOnLive } from './live';

/** Everything waiting on the Commander: the header counter, the rail badge, the inbox. */
@Injectable({ providedIn: 'root' })
export class NeedsYou {
  readonly inbox = httpResource<ApprovalsView>(() => apiUrl.approvals());
  readonly backbriefs = computed(() => this.inbox.value()?.backbriefs ?? []);
  /** Everything else: blocked bots, failed tasks (backbriefs are listed separately). */
  readonly items = computed(() =>
    (this.inbox.value()?.attention ?? []).filter(
      (a) => !this.backbriefs().some((b) => b.id === a.entityId),
    ),
  );
  /** What HQ recommends (D130): shown in the inbox, never counted as waiting on the Commander. */
  readonly recommendations = computed(() => this.inbox.value()?.recommendations ?? []);
  readonly count = computed(() => this.inbox.value()?.attention.length ?? 0);
  readonly approvals = computed(() => this.backbriefs().length);

  constructor() {
    reloadOnLive(
      (n) =>
        (n.type === 'version' &&
          ['task', 'bot', 'mission', 'backbrief', 'unit', 'operation', 'recommendation'].includes(
            n.version.entityType,
          )) ||
        (n.type === 'event' &&
          ['escalation', 'escalation.resolved', 'budget.warning', 'cost'].includes(n.event.kind)),
      () => this.inbox.reload(),
      300,
    );
  }

  reload(): void {
    this.inbox.reload();
  }
}
