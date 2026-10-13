import { Can } from '../../ui/can';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { SupplyView, UnitView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

type Form = 'repository' | 'credential' | 'environment';

/** Only what the Commander has connected exists. Connect it here, then issue it to units. */
@Component({
  selector: 'orb-supply-page',
  imports: [Can, FormsModule, RouterLink, EmptyState, Icon, LoadError, Skeleton, Term],
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1><orb-term key="supply-depot">Supply Depot</orb-term></h1>
          <p class="page-header__lede">
            Repositories, environments and credential references you have connected. Units can only
            use what is issued to them.
          </p>
        </div>
      </header>

      @if (connect(); as wanted) {
        <p class="panel notice" role="status">
          <orb-icon name="info" />
          <span
            >An Overseer asked for <strong>{{ wanted }}</strong
            >, which is not connected yet. Connect it below, then issue it in chat or here.</span
          >
        </p>
      }

      <section *orbCan="null" class="panel" aria-labelledby="connect-h">
        <h2 id="connect-h" class="panel__title">Connect</h2>
        <div class="tabs" role="group" aria-label="What to connect">
          @for (f of forms; track f) {
            <button
              type="button"
              class="btn btn--ghost"
              [attr.aria-pressed]="form() === f"
              (click)="form.set(f)"
            >
              {{ f }}
            </button>
          }
        </div>
        @switch (form()) {
          @case ('repository') {
            <form class="form" (ngSubmit)="connectRepo()">
              <label for="repo-name">Name</label>
              <input
                id="repo-name"
                name="name"
                class="input"
                required
                [(ngModel)]="repo.name"
                placeholder="payments-service"
              />
              <label for="repo-loc">Local path or clone URL</label>
              <input
                id="repo-loc"
                name="location"
                class="input"
                required
                [(ngModel)]="repo.location"
                placeholder="/home/me/src/payments-service"
              />
              <p class="hint">
                Never put a token in the URL: store it as a credential and refer to it by name.
              </p>
              <div class="actions">
                <button type="submit" class="btn btn--primary" [disabled]="busy()">
                  Connect repository
                </button>
              </div>
            </form>
          }
          @case ('credential') {
            <form class="form" (ngSubmit)="storeCredential()">
              <label for="cred-name">Name</label>
              <input
                id="cred-name"
                name="name"
                class="input"
                required
                [(ngModel)]="cred.name"
                placeholder="payments-deploy-token"
              />
              <label for="cred-value">Value</label>
              <input
                id="cred-value"
                name="value"
                class="input"
                type="password"
                autocomplete="off"
                required
                [(ngModel)]="cred.value"
              />
              <p class="hint">
                Write-only. The value goes to the encrypted secrets store and is never shown again;
                everything else refers to it by name.
              </p>
              <div class="actions">
                <button type="submit" class="btn btn--primary" [disabled]="busy()">
                  Store credential
                </button>
              </div>
            </form>
          }
          @case ('environment') {
            <form class="form" (ngSubmit)="connectEnv()">
              <label for="env-name">Name</label>
              <input
                id="env-name"
                name="name"
                class="input"
                required
                [(ngModel)]="env.name"
                placeholder="staging"
              />
              <label for="env-tier">Tier</label>
              <select id="env-tier" name="tier" class="input" [(ngModel)]="env.tier">
                <option value="staging">staging</option>
                <option value="production">
                  production (issuing it = deploy rights; cannot be undone)
                </option>
              </select>
              <div class="actions">
                <button type="submit" class="btn btn--primary" [disabled]="busy()">
                  Connect environment
                </button>
              </div>
            </form>
          }
        }
      </section>

      @if (supply.error(); as err) {
        <orb-load-error [error]="err" (retry)="supply.reload()" />
      } @else if (supply.hasValue()) {
        <section aria-labelledby="stock-h">
          <h2 id="stock-h" class="panel__title">In the depot</h2>
          <ul class="list-reset stock">
            @for (s of supply.value(); track s.id) {
              <li class="panel">
                <div class="row">
                  <orb-icon [name]="icon(s)" />
                  <strong>{{ s.name }}</strong>
                  <span class="chip">{{ s.spec.kind }}{{ tier(s) ? ' · ' + tier(s) : '' }}</span>
                  <span class="meta">{{ s.connected ? 'connected' : 'not connected' }}</span>
                </div>
                <div class="row holders">
                  <span class="meta">Issued to:</span>
                  @for (u of holders(s.id); track u.id) {
                    <span class="chip">
                      <a [routerLink]="['/units', u.id]" [queryParams]="{ section: 'supply' }">{{
                        u.name
                      }}</a>
                      @if (!(s.spec.kind === 'environment' && tier(s) === 'production')) {
                        <button
                          type="button"
                          class="x"
                          [attr.aria-label]="'Withdraw ' + s.name + ' from ' + u.name"
                          (click)="allot(s, u, true)"
                        >
                          <orb-icon class="sm" name="x" />
                        </button>
                      }
                    </span>
                  } @empty {
                    <span class="meta">nobody</span>
                  }
                  @if (s.spec.kind === 'environment' && tier(s) === 'production') {
                    <span class="meta issue"
                      >Deploy rights cannot be undone: give them by order in chat, which asks you to
                      confirm.</span
                    >
                  } @else {
                    <label class="visually-hidden" [for]="'issue-' + s.id"
                      >Issue {{ s.name }} to</label
                    >
                    <select class="input issue" [id]="'issue-' + s.id" #pick>
                      @for (u of others(s.id); track u.id) {
                        <option [value]="u.id">{{ u.name }}</option>
                      }
                    </select>
                    <button
                      type="button"
                      class="btn small"
                      [disabled]="busy() || !others(s.id).length"
                      (click)="allotById(s, pick.value)"
                    >
                      Issue
                    </button>
                  }
                </div>
              </li>
            } @empty {
              <orb-empty-state icon="key" title="Nothing connected yet"
                >Connect a repository, an environment or a credential above.</orb-empty-state
              >
            }
          </ul>
        </section>
      } @else {
        <orb-skeleton variant="block" [lines]="3" />
      }
    </div>
  `,
  styles: `
    .notice {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      border-color: var(--tone-warning);
    }
    .tabs {
      display: flex;
      gap: var(--space-1);
      margin-bottom: var(--space-3);
      text-transform: capitalize;
      [aria-pressed='true'] {
        background: var(--color-surface-3);
        color: var(--color-text);
      }
    }
    .stock {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }
    .holders {
      margin-top: var(--space-2);
    }
    .x {
      display: inline-flex;
      min-width: var(--space-6);
      min-height: var(--space-6);
      align-items: center;
      justify-content: center;
      border: 0;
      background: none;
      color: inherit;
      cursor: pointer;
    }
    .issue {
      margin-left: auto;
    }
    .small {
      min-height: auto;
      padding: var(--space-1) var(--space-3);
    }
  `,
})
export class SupplyPage implements OnInit {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  /** `?connect=` — what an Overseer said was missing. */
  readonly connect = input<string>();
  protected readonly supply = httpResource<SupplyView[]>(() => apiUrl.supply());
  private readonly unitList = httpResource<UnitView[]>(() => apiUrl.units());
  protected readonly units = computed(() => this.unitList.value() ?? []);
  protected readonly forms: Form[] = ['repository', 'credential', 'environment'];
  protected readonly form = signal<Form>('repository');
  protected readonly busy = signal(false);
  protected repo = { name: '', location: '' };
  protected cred = { name: '', value: '' };
  protected env: { name: string; tier: 'staging' | 'production' } = { name: '', tier: 'staging' };

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Supply Depot', term: 'supply-depot' }]);
    reloadOnLive(
      (n) =>
        n.type === 'version' &&
        (n.version.entityType === 'supply' || n.version.entityType === 'unit'),
      () => {
        this.supply.reload();
        this.unitList.reload();
      },
    );
  }

  ngOnInit(): void {
    const wanted = this.connect();
    if (!wanted) return;
    const kind = /environment/i.test(wanted)
      ? 'environment'
      : /credential|token/i.test(wanted)
        ? 'credential'
        : 'repository';
    this.form.set(kind);
    const name = wanted.replace(/\b(repository|environment|credential)\b/gi, '').trim();
    if (kind === 'repository') this.repo.name = name;
    else if (kind === 'credential') this.cred.name = name;
    else this.env.name = name;
  }

  protected icon(s: SupplyView) {
    return s.spec.kind === 'repository'
      ? 'git-branch'
      : s.spec.kind === 'credential'
        ? 'key'
        : 'coins';
  }

  protected tier(s: SupplyView): string | null {
    return s.spec.kind === 'environment' ? (s.spec.details['tier'] ?? null) : null;
  }

  protected holders(id: string): UnitView[] {
    return this.units().filter((u) => u.supplyIds.includes(id));
  }

  protected others(id: string): UnitView[] {
    return this.units().filter((u) => !u.supplyIds.includes(id));
  }

  protected connectRepo(): Promise<void> {
    return this.act(async () => {
      const s = await this.api.connectRepository(this.repo.name.trim(), this.repo.location.trim());
      this.repo = { name: '', location: '' };
      return `Connected ${s.name}.`;
    });
  }

  protected storeCredential(): Promise<void> {
    return this.act(async () => {
      const s = await this.api.storeCredential(this.cred.name.trim(), this.cred.value);
      this.cred = { name: '', value: '' };
      return `Stored credential ${s.name} (value is write-only).`;
    });
  }

  protected connectEnv(): Promise<void> {
    return this.act(async () => {
      const s = await this.api.connectEnvironment(this.env.name.trim(), this.env.tier);
      this.env = { name: '', tier: 'staging' };
      return `Connected environment ${s.name}.`;
    });
  }

  protected allotById(s: SupplyView, unitId: string): Promise<void> {
    const u = this.units().find((x) => x.id === unitId);
    return u ? this.allot(s, u, false) : Promise.resolve();
  }

  protected allot(s: SupplyView, u: UnitView, revoke: boolean): Promise<void> {
    return this.act(
      async () => {
        await this.api.allotSupply(s.id, u.id, revoke);
        this.unitList.reload();
        return revoke ? `${s.name} withdrawn from ${u.name}.` : `${s.name} issued to ${u.name}.`;
      },
      revoke
        ? undefined
        : async () => {
            await this.api.allotSupply(s.id, u.id, true);
            this.unitList.reload();
          },
    );
  }

  private async act(fn: () => Promise<string>, undo?: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      this.toasts.show({ tone: 'success', message: await fn(), ...(undo ? { undo } : {}) });
      this.supply.reload();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
