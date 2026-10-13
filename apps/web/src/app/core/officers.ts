import { httpResource } from '@angular/common/http';
import { computed, Injectable } from '@angular/core';
import type { OfficerView } from '@orbot/shared';
import { apiUrl } from './api';
import { reloadOnLive } from './live';

/** Officers by actor reference, to say who did something. */
@Injectable({ providedIn: 'root' })
export class Officers {
  private readonly list = httpResource<OfficerView[]>(() => apiUrl.officers());
  private readonly byId = computed(() => new Map((this.list.value() ?? []).map((o) => [o.id, o])));

  constructor() {
    reloadOnLive(
      (n) => n.type === 'version' && n.version.entityType === 'officer',
      () => this.list.reload(),
    );
  }

  /** "Commander", "Ada", or null for anyone who isn't a person. */
  name(actor: string): string | null {
    if (actor.startsWith('commander:')) return 'Commander';
    if (actor.startsWith('officer:')) return this.byId().get(actor.slice(8))?.name ?? 'An officer';
    return null;
  }
}
