import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { BudgetView } from '@orbot/shared';
import { Api } from '../core/api';
import { toUserError, type UserFacingError } from '../core/api-error';
import { openDialog } from './dialog';
import { Toasts } from './toast';

/** Spend against a compute budget cap: a meter, the numbers, and the state in words. */
@Component({
  selector: 'orb-budget',
  template: `
    @let b = budget();
    <div class="budget" [attr.data-state]="b.state">
      @if (b.cap !== null) {
        <div
          class="bar"
          role="meter"
          [attr.aria-label]="label()"
          aria-valuemin="0"
          [attr.aria-valuemax]="b.cap"
          [attr.aria-valuenow]="b.spent > b.cap ? b.cap : b.spent"
          [attr.aria-valuetext]="text()"
        >
          <span class="fill" [style.width.%]="percent()"></span>
          <span class="warn" [style.left.%]="b.warnAt * 100" aria-hidden="true"></span>
        </div>
      }
      <span class="text">{{ text() }}</span>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .budget {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
      --tone: var(--tone-success);
    }
    [data-state='warning'] {
      --tone: var(--tone-warning);
    }
    [data-state='capped'] {
      --tone: var(--tone-danger);
    }
    .bar {
      position: relative;
      flex: 0 1 var(--meter-width);
      width: var(--meter-width);
      height: var(--space-2);
      border-radius: var(--radius-pill);
      background: var(--color-surface-3);
      overflow: hidden;
    }
    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      background: var(--tone);
    }
    .warn {
      position: absolute;
      top: 0;
      bottom: 0;
      width: var(--border-width);
      background: var(--color-text-muted);
    }
    .text {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
      white-space: nowrap;
    }
    [data-state='warning'] .text,
    [data-state='capped'] .text {
      color: var(--tone);
      font-weight: var(--font-weight-medium);
    }
  `,
})
export class BudgetMeter {
  readonly budget = input.required<BudgetView>();
  readonly label = input('Compute budget');
  protected readonly percent = computed(() => {
    const b = this.budget();
    return b.cap ? Math.min(100, (b.spent / b.cap) * 100) : 0;
  });
  protected readonly text = computed(() => {
    const b = this.budget();
    if (b.cap === null) return `${b.spent} units used · no cap`;
    const tail =
      b.state === 'capped' ? ' · at cap, work held' : b.state === 'warning' ? ' · near cap' : '';
    return `${b.spent} of ${b.cap} units${tail}`;
  });
}

interface SetBudgetData {
  scope: 'unit' | 'operation';
  id: string;
  name: string;
  budget: BudgetView;
}

/** Set a cap. Work held at the old cap starts again if the new one leaves room. */
@Component({
  selector: 'orb-set-budget-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Compute budget for {{ data.name }}</h2>
      <p class="hint">
        A hard cap: work stops when spending reaches it, and ORBOT warns at
        {{ data.budget.warnAt * 100 }}%. {{ data.budget.spent }} units spent so far. Leave empty for
        no cap.
      </p>
      <label for="cap">Cap (units)</label>
      <input id="cap" name="cap" class="input" type="number" min="0" step="1" [(ngModel)]="cap" />
      <label for="budget-reason">Reason</label>
      <input id="budget-reason" name="reason" class="input" required [(ngModel)]="reason" />
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy() || !reason.trim()">
          Set budget
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
export class SetBudgetDialog {
  protected readonly data = inject<SetBudgetData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  protected cap: number | null = this.data.budget.cap;
  protected reason = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const units = this.cap === null || (this.cap as unknown) === '' ? null : Math.round(this.cap);
    try {
      await this.api.setBudget(
        this.data.scope,
        this.data.id,
        this.data.scope === 'unit' ? (units ?? 0) : units,
        this.reason.trim(),
      );
      this.ref.close(true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/** The meter plus a "Set budget…" button. */
@Component({
  selector: 'orb-budget-control',
  imports: [BudgetMeter],
  template: `
    <div class="row">
      <orb-budget [budget]="budget()" [label]="'Compute budget of ' + name()" />
      <button type="button" class="btn" (click)="open()">Set budget…</button>
    </div>
  `,
  styles: `
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3);
    }
  `,
})
export class BudgetControl {
  readonly scope = input.required<'unit' | 'operation'>();
  readonly targetId = input.required<string>();
  readonly name = input.required<string>();
  readonly budget = input.required<BudgetView>();
  readonly changed = output<void>();
  private readonly dialog = inject(Dialog);
  private readonly toasts = inject(Toasts);

  protected open(): void {
    const ref = openDialog<boolean, SetBudgetData, SetBudgetDialog>(
      this.dialog,
      SetBudgetDialog,
      { scope: this.scope(), id: this.targetId(), name: this.name(), budget: this.budget() },
      `Compute budget for ${this.name()}`,
    );
    ref.closed.subscribe((ok) => {
      if (!ok) return;
      this.toasts.show({ tone: 'success', message: `Budget for ${this.name()} set.` });
      this.changed.emit();
    });
  }
}
