import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

export interface NewMissionData {
  unitId: string;
  unitName: string;
}

/** Give a unit a mission. Its Overseer drafts a backbrief for approval. */
@Component({
  selector: 'orb-new-mission-dialog',
  imports: [FormsModule, Term],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2 id="new-mission-h">
        New <orb-term key="mission">mission</orb-term> for {{ data.unitName }}
      </h2>
      <p class="hint">
        The Overseer will plan it and send you a <orb-term key="backbrief">backbrief</orb-term> to
        approve.
      </p>
      <label for="goal">Goal</label>
      <input
        id="goal"
        name="goal"
        class="input"
        required
        [(ngModel)]="goal"
        placeholder="e.g. Add audit logging"
        cdkFocusInitial
      />
      <label for="dod">Definition of done <span class="hint">(one item per line)</span></label>
      <textarea id="dod" name="dod" class="input" rows="4" required [(ngModel)]="dod"></textarea>
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button
          type="submit"
          class="btn btn--primary"
          [disabled]="busy() || !goal.trim() || !items().length"
        >
          Give mission
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
export class NewMissionDialog {
  protected readonly data = inject<NewMissionData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected goal = '';
  protected dod = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected items(): string[] {
    return this.dod
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
      .filter(Boolean);
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.createMission({
        unitId: this.data.unitId,
        goal: this.goal.trim(),
        definitionOfDone: this.items(),
      });
      this.toasts.show({
        tone: 'success',
        message: `Mission given to ${this.data.unitName}.`,
        detail: 'The Overseer is drafting a backbrief.',
      });
      this.ref.close(true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
