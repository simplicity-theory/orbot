import { DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

/**
 * Start a new project: a repository from the single-HTML template, a site ORBOT publishes it
 * to (no server), and the operation that builds it with both assigned.
 */
@Component({
  selector: 'orb-new-project-dialog',
  imports: [FormsModule, Term],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>New project</h2>
      <p class="hint">
        One self-contained HTML file: no build step, no server. ORBOT starts the repository, gives
        the project a site it publishes itself, and launches the
        <orb-term key="operation">operation</orb-term> that builds it.
      </p>
      <label for="np-name">Project name</label>
      <input
        id="np-name"
        name="name"
        class="input"
        required
        maxlength="60"
        pattern="[A-Za-z0-9][A-Za-z0-9 ._-]*"
        [(ngModel)]="name"
        placeholder="Ledger"
      />
      <label for="np-intent">Intent</label>
      <textarea
        id="np-intent"
        name="intent"
        class="input"
        rows="3"
        [(ngModel)]="intent"
        placeholder="A personal ledger that works offline and keeps its data in the browser."
      ></textarea>
      <p class="hint">
        Leave the intent empty to make only the repository and the site, and state it later.
      </p>
      <label for="np-budget"
        >Compute budget <span class="hint">(optional hard cap, in units)</span></label
      >
      <input
        id="np-budget"
        name="budget"
        class="input"
        type="number"
        min="1"
        step="1"
        [(ngModel)]="budget"
      />
      <p class="hint">
        The site is ORBOT’s own, no server: the unit that deploys gets it with its mission, and each
        deploy still waits for your approval.
      </p>
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy() || !name.trim()">
          {{ intent.trim() ? 'Start project and launch' : 'Start project' }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
    .check {
      display: flex;
      gap: var(--space-2);
      align-items: baseline;
      font-weight: var(--font-weight-regular);
    }
  `,
})
export class NewProjectDialog {
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected name = '';
  protected intent = '';
  protected budget: number | null = null;
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const p = await this.api.startProject({
        name: this.name.trim(),
        kind: 'single-html',
        intent: this.intent.trim() || null,
        budgetUnits: this.budget || null,
        deployRightsUnitId: null,
      });
      this.ref.close();
      if (p.operation) {
        this.toasts.show({
          tone: 'success',
          message: `Project ${p.repository.name} started; Operation ${p.operation.name} launched.`,
        });
        await this.router.navigate(['/operations', p.operation.id]);
      } else {
        this.toasts.show({
          tone: 'success',
          message: `Project ${p.repository.name} started: its repository and site are in the Supply Depot.`,
        });
        await this.router.navigate(['/supply']);
      }
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
