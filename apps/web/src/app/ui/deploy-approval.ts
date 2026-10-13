import { Auth } from '../core/auth';
import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { toUserError } from '../core/api-error';
import { NeedsYou } from '../core/needs-you';
import { Toasts } from './toast';

/** Approve or reject a production deploy, wherever it appears. */
@Component({
  selector: 'orb-deploy-approval',
  imports: [FormsModule],
  template: `
    @if (auth.can(unitId())) {
      <div class="row" role="group" [attr.aria-label]="'Decision on ' + label()">
        <button type="button" class="btn btn--primary" [disabled]="busy()" (click)="decide(true)">
          Approve deploy
        </button>
        @if (rejecting()) {
          <label class="visually-hidden" [for]="id">Why reject?</label>
          <input class="input" [id]="id" [(ngModel)]="note" placeholder="Why reject?" />
          <button
            type="button"
            class="btn"
            [disabled]="busy() || !note.trim()"
            (click)="decide(false)"
          >
            Reject
          </button>
        } @else {
          <button
            type="button"
            class="btn btn--ghost"
            [disabled]="busy()"
            (click)="rejecting.set(true)"
          >
            Reject…
          </button>
        }
      </div>
    }
  `,
  styles: `
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }
  `,
})
export class DeployApproval {
  protected readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly needsYou = inject(NeedsYou);
  readonly taskId = input.required<string>();
  /** The unit whose work it is: its Captain (or the Commander) may decide. */
  readonly unitId = input<string | null>(null);
  readonly label = input('production deploy');
  readonly decided = output<void>();
  protected readonly busy = signal(false);
  protected readonly rejecting = signal(false);
  protected readonly id = `deploy-note-${Math.random().toString(36).slice(2, 8)}`;
  protected note = '';

  protected async decide(approve: boolean): Promise<void> {
    this.busy.set(true);
    try {
      const t = await this.api.decideDeploy(
        this.taskId(),
        approve,
        approve ? null : this.note.trim(),
      );
      this.toasts.show({
        tone: approve ? 'success' : 'info',
        message: approve
          ? `Production deploy approved (task #${t.number}).`
          : `Production deploy rejected (task #${t.number}).`,
        detail: 'A deploy decision cannot be undone.',
      });
      this.needsYou.reload();
      this.decided.emit();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
