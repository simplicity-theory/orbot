import { DialogRef } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { SupplyView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

type RepoChoice = 'template' | 'existing' | 'none';

/**
 * Open a theatre: a project with its repository (new from the single-HTML template, or one
 * already in the Supply Depot), a site ORBOT publishes it to if wanted, and the first
 * operation if an intent comes with it.
 */
@Component({
  selector: 'orb-new-theatre-dialog',
  imports: [FormsModule, Term],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>New theatre</h2>
      <p class="hint">
        A <orb-term key="theatre">theatre</orb-term> is one project: the repository its work lands
        in and where it deploys. Every <orb-term key="operation">operation</orb-term> launched in it
        starts with both.
      </p>
      <label for="nt-name">Theatre name</label>
      <input
        id="nt-name"
        name="name"
        class="input"
        required
        maxlength="60"
        pattern="[A-Za-z0-9][A-Za-z0-9 ._-]*"
        [(ngModel)]="name"
        placeholder="Ledger"
      />
      <label for="nt-desc">What it is <span class="hint">(optional)</span></label>
      <input
        id="nt-desc"
        name="description"
        class="input"
        maxlength="500"
        [(ngModel)]="description"
        placeholder="A personal ledger that works offline."
      />
      <fieldset class="choice">
        <legend>Repository</legend>
        <label class="check"
          ><input type="radio" name="repo" value="template" [(ngModel)]="repo" /> Start a new one: a
          single self-contained HTML file (no build, no server)</label
        >
        <label class="check"
          ><input type="radio" name="repo" value="existing" [(ngModel)]="repo" /> One already in the
          Supply Depot</label
        >
        @if (repo === 'existing') {
          <label for="nt-repo" class="visually-hidden">Which repository</label>
          <select id="nt-repo" name="existing" class="input" [(ngModel)]="existingId" required>
            <option value="">Choose a repository…</option>
            @for (r of repos(); track r.id) {
              <option [value]="r.id">{{ r.name }}</option>
            }
          </select>
        }
        <label class="check"
          ><input type="radio" name="repo" value="none" [(ngModel)]="repo" /> None yet (assign one
          on the theatre's page)</label
        >
      </fieldset>
      <label class="check"
        ><input type="checkbox" name="site" [(ngModel)]="site" /> Give it a site ORBOT publishes
        itself (a static site, no server)</label
      >
      <label for="nt-intent">First intent <span class="hint">(optional)</span></label>
      <textarea
        id="nt-intent"
        name="intent"
        class="input"
        rows="3"
        [(ngModel)]="intent"
        placeholder="Build the first version: add, complete and remove items; works offline."
      ></textarea>
      <p class="hint">With an intent, HQ launches the first operation in the theatre right away.</p>
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy() || !valid()">
          {{ intent.trim() ? 'Open theatre and launch' : 'Open theatre' }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
    .choice {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      border: 0;
    }
    .check {
      display: flex;
      gap: var(--space-2);
      align-items: baseline;
      font-weight: var(--font-weight-regular);
    }
  `,
})
export class NewTheatreDialog {
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected readonly depot = httpResource<SupplyView[]>(() => apiUrl.supply());
  protected readonly repos = computed(() =>
    (this.depot.value() ?? []).filter((s) => s.spec.kind === 'repository' && s.connected),
  );
  protected name = '';
  protected description = '';
  protected repo: RepoChoice = 'template';
  protected existingId = '';
  protected site = true;
  protected intent = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected valid(): boolean {
    return !!this.name.trim() && (this.repo !== 'existing' || !!this.existingId);
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const t = await this.api.createTheatre({
        name: this.name.trim(),
        description: this.description.trim(),
        repository:
          this.repo === 'template'
            ? { kind: 'template', template: 'single-html' }
            : this.repo === 'existing'
              ? { kind: 'existing', supplyId: this.existingId }
              : null,
        site: this.site,
        intent: this.intent.trim() || null,
      });
      this.ref.close();
      if (t.operation) {
        this.toasts.show({
          tone: 'success',
          message: `Theatre ${t.theatre.name} opened; Operation ${t.operation.name} launched.`,
        });
        await this.router.navigate(['/operations', t.operation.id]);
      } else {
        this.toasts.show({ tone: 'success', message: `Theatre ${t.theatre.name} opened.` });
        await this.router.navigate(['/theatres', t.theatre.id]);
      }
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
