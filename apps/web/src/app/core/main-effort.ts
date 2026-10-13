import { httpResource } from '@angular/common/http';
import { computed, Injectable } from '@angular/core';
import type { MainEffortView } from '@orbot/shared';
import { apiUrl } from './api';
import { reloadOnLive } from './live';

/** The main effort: the ORBAT strip, operation badges, and main-effort task badges. */
@Injectable({ providedIn: 'root' })
export class MainEfforts {
  readonly view = httpResource<MainEffortView>(() => apiUrl.mainEffort());
  readonly operation = computed(() => this.view.value()?.operation ?? null);
  readonly current = computed(() => this.view.value()?.mainEffort ?? null);
  private readonly missions = computed(() => new Set(this.view.value()?.missionIds ?? []));

  constructor() {
    reloadOnLive(
      (n) => n.type === 'version' && ['settings', 'operation'].includes(n.version.entityType),
      () => this.view.reload(),
    );
  }

  isOperation(id: string): boolean {
    return this.current()?.operationId === id;
  }

  /** Whether a task (by its mission) is part of the main effort. */
  isTask(t: { missionId: string | null }): boolean {
    return !!t.missionId && this.missions().has(t.missionId);
  }

  reload(): void {
    this.view.reload();
  }
}
