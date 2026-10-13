import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { RANK_LABEL, type OfficerView, type Rank } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Toasts } from '../../ui/toast';

export interface OfficerDialogData {
  /** Null to appoint a new officer. */
  officer: OfficerView | null;
  units: { id: string; name: string }[];
}

/** Appoint an officer, or change one's rank and units. */
@Component({
  selector: 'orb-officer-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>{{ data.officer ? 'Change ' + data.officer.name : 'Appoint an officer' }}</h2>
      @if (!data.officer) {
        <label for="o-name">Name</label>
        <input id="o-name" name="name" class="input" required [(ngModel)]="name" cdkFocusInitial />
        <label for="o-login">Login</label>
        <input id="o-login" name="login" class="input" required [(ngModel)]="login" />
      }
      <fieldset class="opts">
        <legend>Rank</legend>
        @for (r of ranks; track r) {
          <label
            ><input type="radio" name="rank" [value]="r" [(ngModel)]="rank" /> {{ label[r] }}</label
          >
        }
      </fieldset>
      <p class="hint">
        A Commander commands everything. A Captain commands the units you choose. An Observer reads
        everything and gives no orders.
      </p>
      @if (rank === 'captain') {
        <fieldset class="opts">
          <legend>Commands</legend>
          @for (u of data.units; track u.id) {
            <label
              ><input
                type="checkbox"
                [checked]="unitIds().includes(u.id)"
                (change)="toggle(u.id)"
              />
              {{ u.name }}</label
            >
          }
        </fieldset>
      }
      @if (!data.officer) {
        <label for="o-pw">First password <span class="hint">(at least 12 characters)</span></label>
        <input
          id="o-pw"
          name="password"
          class="input"
          type="password"
          autocomplete="new-password"
          required
          minlength="12"
          [(ngModel)]="password"
        />
        <p class="hint">Kept hashed in the secrets store; they can change it once signed in.</p>
      } @else {
        <label for="o-reason">Why the change?</label>
        <input id="o-reason" name="reason" class="input" required [(ngModel)]="reason" />
      }
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy()">
          {{ data.officer ? 'Save' : 'Appoint' }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
    .opts {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3) var(--space-5);
      margin: 0;
      padding: 0;
      border: 0;
      legend {
        margin-bottom: var(--space-2);
        color: var(--color-text-muted);
      }
      label {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
      }
    }
  `,
})
export class OfficerDialog {
  protected readonly data = inject<OfficerDialogData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly ranks: Rank[] = ['commander', 'captain', 'observer'];
  protected readonly label = RANK_LABEL;
  protected name = '';
  protected login = '';
  protected password = '';
  protected reason = '';
  protected rank: Rank = this.data.officer?.rank ?? 'captain';
  protected readonly unitIds = signal<string[]>(this.data.officer?.unitIds ?? []);
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected toggle(id: string): void {
    this.unitIds.update((u) => (u.includes(id) ? u.filter((x) => x !== id) : [...u, id]));
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.data.officer) {
        await this.api.updateOfficer(this.data.officer.id, {
          rank: this.rank,
          unitIds: this.unitIds(),
          reason: this.reason.trim() || 'Changed by the Commander',
        });
        this.toasts.show({ tone: 'success', message: `${this.data.officer.name} updated.` });
      } else {
        const o = await this.api.appointOfficer({
          name: this.name.trim(),
          login: this.login.trim(),
          rank: this.rank,
          unitIds: this.unitIds(),
          password: this.password,
        });
        this.toasts.show({
          tone: 'success',
          message: `${o.name} appointed ${RANK_LABEL[o.rank]}.`,
          detail: `They sign in as “${o.login}”.`,
        });
      }
      this.ref.close(true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
