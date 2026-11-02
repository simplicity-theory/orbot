import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icon';
import { Toasts } from '../../ui/toast';

export interface MoveRepositoryData {
  operationId: string;
  name: string;
  to: { id: string; name: string };
  from: string | null;
}

/** Moving an operation whose missions are out: say what it costs, then do it. */
@Component({
  selector: 'orb-move-repository-dialog',
  template: `
    <div class="form">
      <h2>Move Operation {{ data.name }} to {{ data.to.name }}</h2>
      <p class="hint">
        Its missions are withdrawn: running work stops with a handover, and nothing waiting starts.
        HQ then issues them again on {{ data.to.name }}, and each unit briefs back afresh.
      </p>
      <p class="hint">
        What was already done stays on {{ data.from ?? 'the old repository' }}'s branches and on the
        record. Once it is moved, you can take {{ data.from ?? 'the old repository' }} off.
      </p>
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Keep it</button>
        <button type="button" class="btn btn--primary" [disabled]="busy()" (click)="submit()">
          Move to {{ data.to.name }}
        </button>
      </div>
    </div>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class MoveRepositoryDialog {
  protected readonly data = inject<MoveRepositoryData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.setMainRepository(this.data.operationId, this.data.to.id);
      this.ref.close(true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

interface CancelData {
  operationId: string;
  name: string;
}

/** Ask why (optional), then call the operation off. */
@Component({
  selector: 'orb-cancel-operation-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Cancel Operation {{ data.name }}</h2>
      <p class="hint">
        Its missions are withdrawn: running work stops with a handover and nothing waiting starts.
        It closes without an After Action review. Everything done stays on record.
      </p>
      <label for="cancel-note">Why (optional)</label>
      <input
        id="cancel-note"
        name="note"
        class="input"
        [(ngModel)]="note"
        placeholder="e.g. Wrong approach; starting again"
      />
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Keep it</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy()">Cancel operation</button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class CancelOperationDialog {
  protected readonly data = inject<CancelData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  protected note = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.cancelOperation(this.data.operationId, this.note.trim());
      this.ref.close(true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/** "Cancel operation…" in the operation's header. */
@Component({
  selector: 'orb-cancel-operation',
  imports: [Icon],
  template: `
    <button type="button" class="btn" (click)="open()">
      <orb-icon name="x" />
      Cancel operation…
    </button>
  `,
  host: { style: 'display: contents' },
})
export class CancelOperationButton {
  readonly operationId = input.required<string>();
  readonly name = input.required<string>();
  readonly cancelled = output<void>();
  private readonly dialog = inject(Dialog);
  private readonly toasts = inject(Toasts);

  protected open(): void {
    openDialog<boolean, CancelData, CancelOperationDialog>(
      this.dialog,
      CancelOperationDialog,
      { operationId: this.operationId(), name: this.name() },
      `Cancel Operation ${this.name()}`,
    ).closed.subscribe((done) => {
      if (!done) return;
      this.toasts.show({ tone: 'info', message: `Operation ${this.name()} cancelled.` });
      this.cancelled.emit();
    });
  }
}
