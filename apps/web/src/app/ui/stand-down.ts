import { Dialog, DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { StandDownScope } from '@orbot/shared';
import { Api } from '../core/api';
import { toUserError, type UserFacingError } from '../core/api-error';
import { StandDowns } from '../core/stand-down';
import { openDialog } from './dialog';
import { Icon } from './icon';
import { Toasts } from './toast';

interface StandDownData {
  scope: StandDownScope;
  targetId: string | null;
  name: string;
}

/** Ask for the reason, then give the order. */
@Component({
  selector: 'orb-stand-down-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Stand down {{ data.name }}</h2>
      <p class="hint">
        Running work stops and pauses with a handover. Nothing new starts until you resume. Every
        task can be picked up again where it left off.
      </p>
      <label for="sd-reason">Reason</label>
      <input
        id="sd-reason"
        name="reason"
        class="input"
        required
        [(ngModel)]="reason"
        placeholder="e.g. Hold everything until the incident review"
      />
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy() || !reason.trim()">
          Stand down
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
export class StandDownDialog {
  protected readonly data = inject<StandDownData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  protected reason = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const reason = this.reason.trim();
      await this.api.standDown({ scope: this.data.scope, targetId: this.data.targetId, reason });
      this.ref.close(reason);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/**
 * Stand down / Resume work for one bot, one unit, or everything. Shows Resume when an
 * order is on this very target; an order inherited from a wider one is lifted there.
 */
@Component({
  selector: 'orb-stand-down',
  imports: [Icon],
  template: `
    @if (order()) {
      <button
        type="button"
        [class]="compact() ? 'btn btn--ghost' : 'btn'"
        [attr.aria-label]="'Resume work: ' + name()"
        [disabled]="busy()"
        (click)="resume()"
      >
        <orb-icon name="activity" />
        <span class="label">Resume work</span>
      </button>
    } @else {
      <button
        type="button"
        [class]="compact() ? 'btn btn--ghost' : 'btn'"
        [attr.aria-label]="'Stand down ' + name()"
        [disabled]="busy()"
        (click)="standDown()"
      >
        <orb-icon name="octagon-pause" />
        <span class="label">Stand down…</span>
      </button>
    }
  `,
  host: { '[class.compact]': 'compact()' },
  styles: `
    :host {
      display: contents;
    }
    @media (max-width: 48rem) {
      :host(.compact) .label {
        display: none;
      }
    }
  `,
})
export class StandDownButton {
  readonly scope = input.required<StandDownScope>();
  readonly targetId = input<string | null>(null);
  /** "Engineers", "E-2", "all units". */
  readonly name = input.required<string>();
  /** Header style: ghost button. */
  readonly compact = input(false);

  private readonly dialog = inject(Dialog);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly standDowns = inject(StandDowns);
  protected readonly busy = signal(false);
  protected readonly order = computed(() => this.standDowns.orderOn(this.scope(), this.targetId()));

  private get target() {
    return { scope: this.scope(), targetId: this.scope() === 'all' ? null : this.targetId() };
  }

  protected standDown(): void {
    const ref = openDialog<string, StandDownData, StandDownDialog>(
      this.dialog,
      StandDownDialog,
      { ...this.target, name: this.name() },
      `Stand down ${this.name()}`,
    );
    ref.closed.subscribe((reason) => {
      if (!reason) return;
      this.standDowns.reload();
      this.toasts.show({
        tone: 'info',
        message: `${this.label()} stood down.`,
        detail: 'Running work paused with a handover.',
        undo: async () => {
          await this.api.standDown({ ...this.target, reason: 'Undo stand-down' }, true);
          this.standDowns.reload();
        },
      });
    });
  }

  protected async resume(): Promise<void> {
    this.busy.set(true);
    const before = this.order()!;
    try {
      await this.api.standDown({ ...this.target, reason: 'Resumed by the Commander' }, true);
      this.standDowns.reload();
      this.toasts.show({
        tone: 'success',
        message: `${this.label()}: back to work.`,
        detail: 'Paused work is back in the queue.',
        undo: async () => {
          await this.api.standDown({ ...this.target, reason: before.reason });
          this.standDowns.reload();
        },
      });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }

  private label(): string {
    return this.scope() === 'all' ? 'All units' : this.name();
  }
}
