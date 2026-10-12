import { Component, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { toUserError } from '../core/api-error';
import { NeedsYou } from '../core/needs-you';
import { Toasts } from './toast';

/** "Acknowledge" on an escalation that reached the Commander: closes it, on the record. */
@Component({
  selector: 'orb-acknowledge',
  template: `
    <button
      type="button"
      class="btn btn--ghost"
      [attr.aria-label]="'Acknowledge: ' + label()"
      [disabled]="busy()"
      (click)="acknowledge()"
    >
      Acknowledge
    </button>
  `,
})
export class Acknowledge {
  readonly chainId = input.required<string>();
  readonly label = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly needsYou = inject(NeedsYou);
  protected readonly busy = signal(false);

  protected async acknowledge(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.resolveEscalation(this.chainId(), 'Acknowledged by the Commander');
      this.toasts.show({ tone: 'success', message: 'Escalation acknowledged.' });
      this.needsYou.reload();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
