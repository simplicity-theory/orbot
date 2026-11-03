import { DialogRef } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { UnitView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
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
      @if (units.value(); as list) {
        <label for="np-unit">Deploy rights to the site</label>
        <select id="np-unit" name="unit" class="input" [(ngModel)]="deployUnitId">
          <option [ngValue]="null">Not yet (issue them later, with confirmation)</option>
          @for (u of list; track u.id) {
            <option [ngValue]="u.id">{{ u.name }} ({{ u.role }})</option>
          }
        </select>
        @if (deployUnitId) {
          <label class="check">
            <input type="checkbox" name="confirm" [(ngModel)]="confirmed" />
            <span>
              I understand deploy rights cannot be taken back: {{ unitName() }} will publish the
              site whenever a deploy is approved.
            </span>
          </label>
        }
      }
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button
          type="submit"
          class="btn btn--primary"
          [disabled]="busy() || !name.trim() || (!!deployUnitId && !confirmed)"
        >
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
  protected readonly units = httpResource<UnitView[]>(() => apiUrl.units());
  protected name = '';
  protected intent = '';
  protected budget: number | null = null;
  protected deployUnitId: string | null = null;
  protected confirmed = false;
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);
  protected readonly unitName = computed(
    () => this.units.value()?.find((u) => u.id === this.deployUnitId)?.name ?? 'the unit',
  );

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const p = await this.api.startProject({
        name: this.name.trim(),
        kind: 'single-html',
        intent: this.intent.trim() || null,
        budgetUnits: this.budget || null,
        deployRightsUnitId: this.confirmed ? this.deployUnitId : null,
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
