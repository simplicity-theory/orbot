import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

export interface ReconData {
  unitId: string;
  unitName: string;
  repositories: { id: string; name: string }[];
}

/** Send a unit on recon: a bot surveys the code to answer a question, read-only. */
@Component({
  selector: 'orb-recon-dialog',
  imports: [FormsModule, Term, RouterLink],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2><orb-term key="recon">Recon</orb-term> for {{ data.unitName }}</h2>
      <p class="hint">
        A bot studies the code to answer your question and files a report with the unit. It changes
        nothing.
      </p>
      <label for="recon-q">What should it find out?</label>
      <textarea
        id="recon-q"
        name="question"
        class="input"
        rows="3"
        required
        [(ngModel)]="question"
        placeholder="e.g. Where is the login rate limit enforced?"
        cdkFocusInitial
      ></textarea>
      @if (data.repositories.length) {
        <label for="recon-repo">Repository</label>
        <select id="recon-repo" name="repo" class="input" [(ngModel)]="repoId">
          @for (r of data.repositories; track r.id) {
            <option [value]="r.id">{{ r.name }}</option>
          }
        </select>
      } @else {
        <p class="error" role="status">
          {{ data.unitName }} has no repository to survey.
          <a routerLink="/supply" (click)="ref.close()">Allot one from the Supply Depot</a>.
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
          [disabled]="busy() || !question.trim() || !data.repositories.length"
        >
          Send on recon
        </button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
      a {
        text-decoration: underline;
      }
    }
  `,
})
export class ReconDialog {
  protected readonly data = inject<ReconData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  protected question = '';
  protected repoId = this.data.repositories[0]?.id ?? '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const task = await this.api.recon({
        unitId: this.data.unitId,
        question: this.question.trim(),
        repoSupplyId: this.repoId || null,
      });
      this.toasts.show({
        tone: 'success',
        message: `${this.data.unitName} sent on recon (task #${task.number}).`,
        detail: 'The report will be filed with the unit.',
      });
      this.ref.close(true);
      await this.router.navigate(
        task.botId
          ? ['/units', task.unitId, 'bots', task.botId, 'tasks', task.id]
          : ['/units', task.unitId, 'tasks', task.id],
      );
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
