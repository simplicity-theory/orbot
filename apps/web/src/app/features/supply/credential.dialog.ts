import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SupplyView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Toasts } from '../../ui/toast';

export interface CredentialDialogData {
  name?: string;
  /** Start on the several-lines field (an SSH key for a server). */
  multiline?: boolean;
}

/** Store a credential. The value goes to the secrets store and is never shown again. */
@Component({
  selector: 'orb-credential-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Store a credential</h2>
      <label for="cred-name">Name</label>
      <input
        id="cred-name"
        name="name"
        class="input mono"
        required
        aria-describedby="cred-name-hint"
        [(ngModel)]="name"
        placeholder="payments-deploy-token"
      />
      <p id="cred-name-hint" class="hint">
        Lowercase letters, digits, dots, dashes and underscores.
      </p>
      <label class="check"
        ><input type="checkbox" name="multiline" [(ngModel)]="multiline" /> It’s several lines (an
        SSH private key)</label
      >
      <label for="cred-value">Value</label>
      @if (multiline) {
        <textarea
          id="cred-value"
          name="value"
          class="input mono"
          rows="7"
          autocomplete="off"
          spellcheck="false"
          required
          [(ngModel)]="value"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
        ></textarea>
      } @else {
        <input
          id="cred-value"
          name="value"
          class="input"
          type="password"
          autocomplete="off"
          required
          [(ngModel)]="value"
        />
      }
      <p class="hint">
        Write-only. The value goes to the encrypted secrets store and is never shown again;
        everything else refers to it by name.
        @if (multiline) {
          For a server, use a key without a passphrase.
        }
      </p>
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button
          type="submit"
          class="btn btn--primary"
          [disabled]="busy() || !name.trim() || !value"
        >
          Store credential
        </button>
      </div>
    </form>
  `,
  styles: `
    .check {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      font-weight: var(--font-weight-regular);
    }
    textarea {
      font-family: var(--font-mono);
    }
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class CredentialDialog {
  private readonly data = inject<CredentialDialogData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<SupplyView>>(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected name = this.data.name ?? '';
  protected value = '';
  protected multiline = this.data.multiline ?? false;
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const s = await this.api.storeCredential(this.name.trim(), this.value);
      this.value = '';
      this.toasts.show({
        tone: 'success',
        message: `Stored credential ${s.name} (value is write-only).`,
      });
      this.ref.close(s);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
