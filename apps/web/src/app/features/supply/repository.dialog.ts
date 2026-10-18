import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SupplyView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Toasts } from '../../ui/toast';

export interface RepositoryDialogData {
  /** Pre-filled from what an Overseer asked for. */
  name?: string;
}

/** Connect a repository: a local path or a clone URL, never with a token in it. */
@Component({
  selector: 'orb-repository-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Connect a repository</h2>
      <label for="repo-name">Name</label>
      <input
        id="repo-name"
        name="name"
        class="input"
        required
        [(ngModel)]="name"
        placeholder="payments-service"
      />
      <label for="repo-loc">Local path or clone URL</label>
      <input
        id="repo-loc"
        name="location"
        class="input mono"
        required
        [(ngModel)]="location"
        placeholder="/home/me/src/payments-service"
      />
      <p class="hint">
        Never put a token in the URL: store it as a credential and refer to it by name.
      </p>
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button
          type="submit"
          class="btn btn--primary"
          [disabled]="busy() || !name.trim() || !location.trim()"
        >
          Connect repository
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
export class RepositoryDialog {
  private readonly data = inject<RepositoryDialogData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<SupplyView>>(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected name = this.data.name ?? '';
  protected location = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const s = await this.api.connectRepository(this.name.trim(), this.location.trim());
      this.toasts.show({ tone: 'success', message: `Connected ${s.name}.` });
      this.ref.close(s);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
