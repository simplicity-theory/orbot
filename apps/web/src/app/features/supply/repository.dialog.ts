import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SupplyView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Toasts } from '../../ui/toast';

export interface RepositoryDialogData {
  /** Pre-filled from what an Overseer asked for. */
  name?: string;
}

type Mode = 'connect' | 'new';

/**
 * Connect a repository (a local path or a clone URL, never with a token in it), or start one
 * from a template: ORBOT makes the first commit and connects it.
 */
@Component({
  selector: 'orb-repository-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>{{ mode === 'new' ? 'Start a repository' : 'Connect a repository' }}</h2>
      <fieldset class="modes">
        <legend class="sr-only">Existing or new</legend>
        <label class="mode" [class.on]="mode === 'connect'">
          <input type="radio" name="mode" value="connect" [(ngModel)]="mode" />
          <span>Connect an existing repository</span>
        </label>
        <label class="mode" [class.on]="mode === 'new'">
          <input type="radio" name="mode" value="new" [(ngModel)]="mode" />
          <span>Start a new one from a template</span>
        </label>
      </fieldset>
      <label for="repo-name">Name</label>
      <input
        id="repo-name"
        name="name"
        class="input"
        required
        [(ngModel)]="name"
        [placeholder]="mode === 'new' ? 'Ledger' : 'payments-service'"
      />
      @if (mode === 'new') {
        <label for="repo-template">Template</label>
        <select id="repo-template" name="template" class="input" [(ngModel)]="template">
          <option value="single-html">Single HTML file: one self-contained page, no server</option>
          <option value="empty">Empty: a README only</option>
        </select>
        <p class="hint">
          @if (template === 'single-html') {
            The product is <span class="mono">index.html</span> alone. Every bot is briefed with
            that rule, and a deploy publishes the file to the project’s site.
          } @else {
            ORBOT creates the repository with a first commit and connects it.
          }
        </p>
      } @else {
        <label for="repo-loc">Local path or clone URL</label>
        <input
          id="repo-loc"
          name="location"
          class="input mono"
          required
          [(ngModel)]="location"
          placeholder="/home/me/src/payments-service"
        />
        <p class="hint">
          Never put a token in the URL: store it as a credential and refer to it by name.
        </p>
      }
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button
          type="submit"
          class="btn btn--primary"
          [disabled]="busy() || !name.trim() || (mode === 'connect' && !location.trim())"
        >
          {{ mode === 'new' ? 'Start repository' : 'Connect repository' }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
    .modes {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      border: 0;
    }
    .mode {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      font-weight: var(--font-weight-regular);
      cursor: pointer;
      &.on {
        border-color: var(--color-accent);
      }
    }
  `,
})
export class RepositoryDialog {
  private readonly data = inject<RepositoryDialogData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<SupplyView>>(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected name = this.data.name ?? '';
  protected location = '';
  protected mode: Mode = 'connect';
  protected template: 'single-html' | 'empty' = 'single-html';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const s =
        this.mode === 'new'
          ? await this.api.createRepository(this.name.trim(), this.template)
          : await this.api.connectRepository(this.name.trim(), this.location.trim());
      this.toasts.show({
        tone: 'success',
        message: this.mode === 'new' ? `Started ${s.name}.` : `Connected ${s.name}.`,
      });
      this.ref.close(s);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
