import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import type { OfficerView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Toasts } from '../../ui/toast';

/** Set a new password for an officer. Write-only: it is never shown again. */
@Component({
  selector: 'orb-password-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Reset {{ officer.name }}'s password</h2>
      <label for="reset-pw">New password <span class="hint">(at least 12 characters)</span></label>
      <input
        id="reset-pw"
        name="pw"
        class="input"
        type="password"
        autocomplete="new-password"
        minlength="12"
        required
        [(ngModel)]="password"
        cdkFocusInitial
      />
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy() || password.length < 12">
          Reset password
        </button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class PasswordDialog {
  protected readonly officer = inject<OfficerView>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.setOfficerPassword(this.officer.id, this.password);
      this.toasts.show({ tone: 'success', message: `Password reset for ${this.officer.name}.` });
      this.ref.close(true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
