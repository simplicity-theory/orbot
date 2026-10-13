import { Dialog } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RANK_LABEL, type OfficerView, type UnitView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Auth } from '../../core/auth';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { Can } from '../../ui/can';
import { openDialog } from '../../ui/dialog';
import { EmptyState } from '../../ui/empty-state';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Toasts } from '../../ui/toast';
import { OfficerDialog, type OfficerDialogData } from './officer.dialog';
import { PasswordDialog } from './password.dialog';

/** Officers: who else can sign in, at what rank, commanding which units. */
@Component({
  selector: 'orb-officers-page',
  imports: [Can, EmptyState, FormsModule, LoadError, Skeleton],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Officers</h1>
          <p class="page-header__lede">
            Who else can sign in. A Commander commands everything, a Captain their units, an
            Observer reads. Officers are retired, never deleted.
          </p>
        </div>
        <button *orbCan="null" type="button" class="btn btn--primary" (click)="edit(null)">
          Appoint an officer
        </button>
      </header>

      <section class="panel" aria-labelledby="me-h">
        <h2 id="me-h" class="panel__title">You</h2>
        <p>
          {{ auth.principal()?.displayName }} — {{ auth.rankLabel() }}
          @if (auth.principal()?.kind === 'officer') {
            <button type="button" class="btn btn--ghost" (click)="changing.set(!changing())">
              Change my password
            </button>
          }
        </p>
        @if (changing()) {
          <form class="form inline" (ngSubmit)="changeMine()">
            <label for="my-pw"
              >New password <span class="hint">(at least 12 characters)</span></label
            >
            <input
              id="my-pw"
              name="pw"
              class="input"
              type="password"
              autocomplete="new-password"
              minlength="12"
              required
              [(ngModel)]="newPassword"
            />
            <div class="actions">
              <button type="submit" class="btn btn--primary" [disabled]="newPassword.length < 12">
                Save password
              </button>
            </div>
          </form>
        }
      </section>

      @if (officers.error(); as err) {
        <orb-load-error [error]="err" (retry)="officers.reload()" />
      } @else if (officers.value(); as list) {
        @if (list.length) {
          <section class="panel" aria-labelledby="officers-h">
            <h2 id="officers-h" class="panel__title">Officers</h2>
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Login</th>
                  <th scope="col">Rank</th>
                  <th scope="col">Commands</th>
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (o of list; track o.id) {
                  <tr [class.retired]="o.retired">
                    <td>{{ o.name }}</td>
                    <td class="mono">{{ o.login }}</td>
                    <td>{{ o.retired ? 'Retired' : label[o.rank] }}</td>
                    <td>
                      {{
                        o.rank === 'captain'
                          ? unitNames(o.unitIds)
                          : o.rank === 'commander'
                            ? 'Everything'
                            : '—'
                      }}
                    </td>
                    <td class="actions-cell">
                      <ng-container *orbCan="null">
                        @if (!o.retired) {
                          <button type="button" class="btn btn--ghost" (click)="edit(o)">
                            Change…
                          </button>
                          <button type="button" class="btn btn--ghost" (click)="reset(o)">
                            Reset password…
                          </button>
                        }
                        <button
                          type="button"
                          class="btn btn--ghost"
                          (click)="retire(o, !o.retired)"
                        >
                          {{ o.retired ? 'Reinstate' : 'Retire' }}
                        </button>
                      </ng-container>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        } @else {
          <orb-empty-state icon="users" title="No other officers yet">
            Appoint officers so others can sign in: Captains to command some units, Observers to
            follow along.
          </orb-empty-state>
        }
      } @else {
        <orb-skeleton variant="block" [lines]="3" />
      }
    </div>
  `,
  styles: `
    .table {
      width: 100%;
      border-collapse: collapse;
      th,
      td {
        text-align: left;
        padding: var(--space-2);
        border-bottom: var(--border-width) solid var(--color-border);
      }
    }
    .retired td {
      color: var(--color-text-muted);
    }
    .actions-cell {
      text-align: right;
      white-space: nowrap;
    }
  `,
})
export class OfficersPage {
  protected readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly dialog = inject(Dialog);
  protected readonly officers = httpResource<OfficerView[]>(() => apiUrl.officers());
  private readonly units = httpResource<UnitView[]>(() => apiUrl.units());
  private readonly unitList = computed(() =>
    (this.units.value() ?? []).map((u) => ({ id: u.id, name: u.name })),
  );
  protected readonly label = RANK_LABEL;
  protected readonly changing = signal(false);
  protected newPassword = '';

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Officers' }]);
    reloadOnLive(
      (n) => n.type === 'version' && n.version.entityType === 'officer',
      () => this.officers.reload(),
    );
  }

  protected unitNames(ids: string[]): string {
    return ids.map((id) => this.unitList().find((u) => u.id === id)?.name ?? '?').join(', ');
  }

  protected edit(officer: OfficerView | null): void {
    openDialog<boolean, OfficerDialogData, OfficerDialog>(
      this.dialog,
      OfficerDialog,
      { officer, units: this.unitList() },
      officer ? `Change ${officer.name}` : 'Appoint an officer',
    ).closed.subscribe(() => this.officers.reload());
  }

  protected async retire(o: OfficerView, retired: boolean): Promise<void> {
    try {
      await this.api.updateOfficer(o.id, {
        retired,
        reason: retired ? 'Retired by the Commander' : 'Reinstated by the Commander',
      });
      this.officers.reload();
      this.toasts.show({
        tone: 'success',
        message: retired ? `${o.name} retired: signed out everywhere.` : `${o.name} reinstated.`,
        undo: async () => {
          await this.api.updateOfficer(o.id, { retired: !retired, reason: 'Undo' });
          this.officers.reload();
        },
      });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    }
  }

  protected reset(o: OfficerView): void {
    openDialog<boolean, OfficerView, PasswordDialog>(
      this.dialog,
      PasswordDialog,
      o,
      `Reset ${o.name}'s password`,
    );
  }

  protected async changeMine(): Promise<void> {
    const p = this.auth.principal();
    if (!p) return;
    try {
      await this.api.setOfficerPassword(p.id, this.newPassword);
      this.newPassword = '';
      this.changing.set(false);
      this.toasts.show({ tone: 'success', message: 'Your password is changed.' });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    }
  }
}
