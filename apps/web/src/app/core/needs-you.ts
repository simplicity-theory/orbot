import { httpResource } from '@angular/common/http';
import { computed, Injectable } from '@angular/core';
import type { OrbatView } from '@orbot/shared';
import { apiUrl } from './api';
import { reloadOnLive } from './live';

/** Everything waiting on the Commander, for the header counter and the rail badge. */
@Injectable({ providedIn: 'root' })
export class NeedsYou {
  private readonly orbat = httpResource<OrbatView>(() => apiUrl.orbat());
  readonly count = computed(() => this.orbat.value()?.needsYou ?? 0);
  readonly approvals = computed(
    () =>
      this.orbat
        .value()
        ?.units.flatMap((u) => u.attention)
        .filter((a) => a.kind === 'awaiting-approval').length ?? 0,
  );
  readonly items = computed(
    () =>
      this.orbat
        .value()
        ?.units.flatMap((u) => u.attention.map((a) => ({ ...a, unit: u.unit.name }))) ?? [],
  );

  constructor() {
    reloadOnLive(
      (n) =>
        n.type === 'version' &&
        (n.version.entityType === 'task' ||
          n.version.entityType === 'bot' ||
          n.version.entityType === 'mission'),
      () => this.orbat.reload(),
      400,
    );
  }
}
