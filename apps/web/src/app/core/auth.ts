import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RANK_LABEL, type MeView, type Principal, type Rank } from '@orbot/shared';
import { Api } from './api';

/**
 * Who is signed in, their rank, and what they command. `undefined` while checking, `null`
 * when signed out. The server enforces every rule; this only decides what to show.
 */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly api = inject(Api);
  private readonly me = signal<MeView | null | undefined>(undefined);
  readonly principal = computed(() => {
    const m = this.me();
    return m === undefined ? undefined : (m?.principal ?? null);
  });
  readonly rank = computed<Rank>(() => this.me()?.rank ?? 'commander');
  readonly rankLabel = computed(() => RANK_LABEL[this.rank()]);
  readonly isCommander = computed(() => this.rank() === 'commander');
  readonly isObserver = computed(() => this.rank() === 'observer');
  /** Actor reference of whoever is signed in, as it appears on the record. */
  readonly actor = computed(() => {
    const p = this.principal();
    return p ? `${p.kind}:${p.id}` : null;
  });

  /**
   * May they order this? A unit id: the Commander, or a Captain of that unit. `null`:
   * the Commander alone. `'officer'`: any Captain or the Commander.
   */
  can(target: string | null | 'officer'): boolean {
    const m = this.me();
    if (!m) return false;
    if (m.unitIds === 'all') return true;
    if (m.rank === 'observer') return false;
    if (target === 'officer') return true;
    return target !== null && m.unitIds.includes(target);
  }

  async check(): Promise<Principal | null> {
    try {
      const me = await this.api.me();
      this.me.set(me);
      return me.principal;
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        this.me.set(null);
        return null;
      }
      throw err;
    }
  }

  async login(passphrase: string, login?: string): Promise<void> {
    await this.api.login(passphrase, login);
    await this.check();
  }

  async logout(): Promise<void> {
    await this.api.logout();
    this.me.set(null);
  }
}
