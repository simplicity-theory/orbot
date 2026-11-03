import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { SupplyView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';
import { ResourcePicker } from './resource-picker';

/** State intent: HQ turns it into an operation with a mission for each unit. */
@Component({
  selector: 'orb-intent-dialog',
  imports: [FormsModule, ResourcePicker, Term],
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
      @if (theatre; as t) {
        <p class="hint">
          Launched in <strong>Theatre {{ t.theatreName }}</strong
          >: the operation starts with everything the theatre holds{{
            t.hasRepo
              ? '.'
              : ', but the theatre has no repository yet: it will wait at the O Group.'
          }}
        </p>
      }
      <label for="op-name">Code name <span class="hint">(optional)</span></label>
      <input id="op-name" name="name" class="input" [(ngModel)]="name" placeholder="Gatekeeper" />
      <label for="op-budget"
        >Compute budget <span class="hint">(optional hard cap, in units)</span></label
      >
      <input
        id="op-budget"
        name="budget"
        class="input"
        type="number"
        min="1"
        step="1"
        [(ngModel)]="budget"
      />
      @if (!theatre && supply.value(); as list) {
        <orb-resource-picker [supply]="list" [(selected)]="supplyIds" />
        @if (!hasRepo()) {
          <p class="hint">
            It needs at least one repository to work in: without one it waits at the O Group (you
            can assign it later, on the operation's page or in chat).
          </p>
        }
      }
      <label class="check"
        ><input type="checkbox" name="reconFirst" [(ngModel)]="reconFirst" />
        <span
          ><orb-term key="recon">Recon</orb-term> first: the building unit surveys the code, and HQ
          plans once its report is in</span
        ></label
      >
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
    .check {
      display: flex;
      gap: var(--space-2);
      align-items: baseline;
    }
  `,
})
export class IntentDialog {
  protected readonly ref = inject(DialogRef);
  /** Set when opened from a theatre's page: the operation is launched in it. */
  protected readonly theatre = inject<{
    theatreId: string;
    theatreName: string;
    hasRepo: boolean;
  } | null>(DIALOG_DATA, { optional: true });
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected intent = '';
  protected name = '';
  protected budget: number | null = null;
  protected reconFirst = false;
  protected readonly supply = httpResource<SupplyView[]>(() => apiUrl.supply());
  protected readonly supplyIds = signal<string[]>([]);
  protected readonly hasRepo = computed(() =>
    (this.supply.value() ?? []).some(
      (s) => s.spec.kind === 'repository' && this.supplyIds().includes(s.id),
    ),
  );
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    try {
      const op = await this.api.createOperation(
        this.intent.trim(),
        this.name.trim() || undefined,
        this.budget ? Math.round(this.budget) : null,
        this.reconFirst,
        this.supplyIds(),
        this.theatre?.theatreId ?? null,
      );
      this.toasts.show({
        tone: 'success',
        message: `Operation ${op.name} launched.`,
        detail:
          this.hasRepo() || this.theatre?.hasRepo
            ? 'HQ is holding the O Group.'
            : 'It waits at the O Group until it has a repository.',
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
