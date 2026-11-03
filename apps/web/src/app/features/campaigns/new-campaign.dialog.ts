import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

export interface NewCampaignData {
  theatreId: string;
  theatreName: string;
}

/**
 * Plan a campaign in a theatre: a name and the steps, one per line. HQ launches step 1 as an
 * operation now and each next step when the one before it closes.
 */
@Component({
  selector: 'orb-new-campaign-dialog',
  imports: [FormsModule, Term],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Plan a campaign in Theatre {{ data.theatreName }}</h2>
      <p class="hint">
        A <orb-term key="campaign">campaign</orb-term> runs several
        <orb-term key="operation">operations</orb-term> one after another toward one end. Each step
        is an intent; HQ launches the first now and each next one when the one before it closes.
      </p>
      <label for="nc-name">Campaign name</label>
      <input
        id="nc-name"
        name="name"
        class="input"
        required
        maxlength="100"
        [(ngModel)]="name"
        placeholder="Polish"
      />
      <label for="nc-desc">The end state <span class="hint">(optional)</span></label>
      <input
        id="nc-desc"
        name="description"
        class="input"
        maxlength="1000"
        [(ngModel)]="description"
        placeholder="An app people enjoy using every day."
      />
      <label for="nc-steps">Steps, one per line, in order</label>
      <textarea
        id="nc-steps"
        name="steps"
        class="input"
        rows="6"
        required
        [(ngModel)]="steps"
        placeholder="Add a due date to each item.
Let items be sorted by due date.
Add a weekly summary view."
      ></textarea>
      <p class="hint">{{ parsed().length }} step(s).</p>
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy() || !valid()">
          Plan and launch step 1
        </button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
    textarea {
      resize: vertical;
    }
  `,
})
export class NewCampaignDialog {
  protected readonly data = inject<NewCampaignData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected name = '';
  protected description = '';
  protected steps = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  /** One step per line; a leading "1." or "-" is dropped. */
  protected parsed(): string[] {
    return this.steps
      .split(/\r?\n/)
      .map((s) => s.trim().replace(/^(\d+[.)]|[-*•])\s*/, ''))
      .filter(Boolean);
  }

  protected valid(): boolean {
    return !!this.name.trim() && this.parsed().length > 0;
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const c = await this.api.planCampaign(this.data.theatreId, {
        name: this.name.trim(),
        description: this.description.trim(),
        steps: this.parsed().map((intent) => ({ intent })),
      });
      this.ref.close();
      this.toasts.show({
        tone: 'success',
        message: `Campaign ${c.campaign.name} planned; step 1 launched as Operation ${c.steps[0]?.operation?.name ?? ''}.`,
      });
      await this.router.navigate(['/campaigns', c.campaign.id]);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
