import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { TaskPermission } from '@orbot/shared';
import { Api } from '../core/api';
import { toUserError } from '../core/api-error';
import { Auth } from '../core/auth';
import { NeedsYou } from '../core/needs-you';
import { Toasts } from './toast';

/** What a bot asked permission for (rules of engagement), and the decision on it. */
@Component({
  selector: 'orb-permission-decision',
  imports: [FormsModule],
  template: `
    @let p = permission();
    <dl class="ask">
      <dt>Wants to</dt>
      <dd>{{ p.action }}</dd>
      @if (p.rule) {
        <dt>Rule</dt>
        <dd>Must escalate: “{{ p.rule }}”</dd>
      }
      @if (p.reason) {
        <dt>Why</dt>
        <dd>{{ p.reason }}</dd>
      }
    </dl>
    @if (auth.can(unitId())) {
      <div class="row" role="group" [attr.aria-label]="'Decision on ' + label()">
        <button type="button" class="btn btn--primary" [disabled]="busy()" (click)="decide(true)">
          Give permission
        </button>
        @if (refusing()) {
          <label class="visually-hidden" [for]="id">Why refuse?</label>
          <input class="input" [id]="id" [(ngModel)]="note" placeholder="Why refuse?" />
          <button
            type="button"
            class="btn"
            [disabled]="busy() || !note.trim()"
            (click)="decide(false)"
          >
            Refuse
          </button>
        } @else {
          <button
            type="button"
            class="btn btn--ghost"
            [disabled]="busy()"
            (click)="refusing.set(true)"
          >
            Refuse…
          </button>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .ask {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: var(--space-1) var(--space-3);
      margin: 0;
      dt {
        color: var(--color-text-muted);
      }
      dd {
        margin: 0;
      }
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }
  `,
})
export class PermissionDecision {
  protected readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly needsYou = inject(NeedsYou);
  readonly taskId = input.required<string>();
  readonly permission = input.required<TaskPermission>();
  /** The unit whose bot asked: its Captain (or the Commander) may decide. */
  readonly unitId = input<string | null>(null);
  readonly label = input('permission request');
  readonly decided = output<void>();
  protected readonly busy = signal(false);
  protected readonly refusing = signal(false);
  protected readonly id = `permission-note-${Math.random().toString(36).slice(2, 8)}`;
  protected note = '';

  protected async decide(approve: boolean): Promise<void> {
    this.busy.set(true);
    try {
      const t = await this.api.decidePermission(
        this.taskId(),
        approve,
        approve ? null : this.note.trim(),
      );
      this.toasts.show({
        tone: approve ? 'success' : 'info',
        message: approve
          ? `Permission given (task #${t.number}).`
          : `Permission refused (task #${t.number}).`,
        detail: 'The bot carries on with your decision in its brief.',
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
