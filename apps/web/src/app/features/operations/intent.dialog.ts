import { DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

/** State intent: HQ turns it into an operation with a mission for each unit. */
@Component({
  selector: 'orb-intent-dialog',
  imports: [FormsModule, Term],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>State your <orb-term key="intent">intent</orb-term></h2>
      <p class="hint">
        What you want achieved, and why. HQ holds the <orb-term key="o-group">O Group</orb-term>,
        issues a mission to each unit in handoff order, and each unit briefs its plan back to you.
      </p>
      <label for="intent">Intent</label>
      <textarea
        id="intent"
        name="intent"
        class="input"
        rows="3"
        required
        [(ngModel)]="intent"
        placeholder="Ship login rate limiting to production."
      ></textarea>
      <label for="op-name">Code name <span class="hint">(optional)</span></label>
      <input id="op-name" name="name" class="input" [(ngModel)]="name" placeholder="Gatekeeper" />
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy() || !intent.trim()">
          Launch operation
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
export class IntentDialog {
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected intent = '';
  protected name = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    try {
      const op = await this.api.createOperation(this.intent.trim(), this.name.trim() || undefined);
      this.toasts.show({
        tone: 'success',
        message: `Operation ${op.name} launched.`,
        detail: 'HQ is holding the O Group.',
      });
      this.ref.close();
      void this.router.navigate(['/operations', op.id]);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
