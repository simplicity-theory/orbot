import { Component, computed, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { toUserError } from '../core/api-error';
import { MainEfforts } from '../core/main-effort';
import { Icon } from './icon';
import { Term } from './term';
import { Toasts } from './toast';

/** "Main effort" marker on an operation or a task. */
@Component({
  selector: 'orb-main-effort-badge',
  imports: [Icon, Term],
  template: `<span class="chip main-effort"
    ><orb-icon name="crosshair" /><orb-term key="main-effort">Main effort</orb-term></span
  >`,
  styles: `
    .main-effort {
      color: var(--tone-active);
      font-weight: var(--font-weight-semibold);
    }
  `,
})
export class MainEffortBadge {}

/** Make an operation the main effort, or stand it back to a supporting effort. With Undo. */
@Component({
  selector: 'orb-main-effort-button',
  imports: [Icon],
  template: `
    @if (isMain()) {
      <button type="button" class="btn" [disabled]="busy()" (click)="set(null)">
        <orb-icon name="x" /> Clear main effort
      </button>
    } @else {
      <button type="button" class="btn" [disabled]="busy()" (click)="set(operationId())">
        <orb-icon name="crosshair" /> Make main effort
      </button>
    }
  `,
})
export class MainEffortButton {
  readonly operationId = input.required<string>();
  /** "Operation Login Rate Limiting". */
  readonly name = input.required<string>();

  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly efforts = inject(MainEfforts);
  protected readonly busy = signal(false);
  protected readonly isMain = computed(() => this.efforts.isOperation(this.operationId()));

  protected async set(operationId: string | null): Promise<void> {
    const before = this.efforts.current()?.operationId ?? null;
    this.busy.set(true);
    try {
      await this.api.setMainEffort(
        operationId,
        operationId ? 'Named by the Commander' : 'Cleared by the Commander',
      );
      this.efforts.reload();
      this.toasts.show({
        tone: 'success',
        message: operationId
          ? `${this.name()} is now the main effort.`
          : `${this.name()} is no longer the main effort.`,
        detail: operationId
          ? 'Its tasks go first; other work makes way for it.'
          : 'Work goes in normal queue order.',
        undo: async () => {
          await this.api.setMainEffort(before, 'Undo');
          this.efforts.reload();
        },
      });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
