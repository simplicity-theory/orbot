import { httpResource } from '@angular/common/http';
import { computed, Injectable } from '@angular/core';
import type { Halt, StandDownView } from '@orbot/shared';
import { apiUrl } from './api';
import { reloadOnLive } from './live';

/** Every stand-down order in force: the banner, and the Stand down / Resume controls. */
@Injectable({ providedIn: 'root' })
export class StandDowns {
  readonly view = httpResource<StandDownView>(() => apiUrl.standDown());
  readonly all = computed(() => this.view.value()?.all ?? null);
  readonly units = computed(() => this.view.value()?.units ?? []);
  readonly bots = computed(() => this.view.value()?.bots ?? []);
  readonly any = computed(() => !!this.all() || this.units().length > 0 || this.bots().length > 0);

  constructor() {
    reloadOnLive(
      (n) => n.type === 'version' && ['settings', 'unit', 'bot'].includes(n.version.entityType),
      () => this.view.reload(),
    );
  }

  /** The order placed on exactly this target (not one inherited from a wider order). */
  orderOn(scope: 'all' | 'unit' | 'bot', id: string | null): Halt | null {
    if (scope === 'all') return this.all();
    if (scope === 'unit') return this.units().find((u) => u.id === id)?.halt ?? null;
    return this.bots().find((b) => b.id === id)?.halt ?? null;
  }

  reload(): void {
    this.view.reload();
  }
}
