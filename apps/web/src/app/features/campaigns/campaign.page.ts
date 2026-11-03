import { Can } from '../../ui/can';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { CampaignSummary, Status } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { PageTitle } from '../../core/title';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { PhaseStepper } from '../../ui/phase-stepper';
import { Skeleton } from '../../ui/skeleton';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';
import { UrlPipe } from '../../ui/url.pipe';

interface CancelData {
  campaignId: string;
  name: string;
}

/** Ask why (optional), then call the campaign off: its operation under way is cancelled too. */
@Component({
  selector: 'orb-cancel-campaign-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Call off Campaign {{ data.name }}</h2>
      <p class="hint">
        The operation under way is cancelled with it: running work stops with a handover. Steps
        already done stay done; nothing is deleted.
      </p>
      <label for="cc-note">Why (optional)</label>
      <input
        id="cc-note"
        name="note"
        class="input"
        [(ngModel)]="note"
        placeholder="Priorities changed"
      />
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Keep it going</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy()">Call it off</button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class CancelCampaignDialog {
  protected readonly data = inject<CancelData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  protected note = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.cancelCampaign(this.data.campaignId, this.note.trim());
      this.ref.close(true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

const STEP_STATUS: Record<CampaignSummary['steps'][number]['status'], Status> = {
  done: 'done',
  'under-way': 'working',
  held: 'blocked',
  waiting: 'queued',
  cancelled: 'stood-down',
};

/** One campaign: its steps in order, each with the operation launched for it, and what it waits for. */
@Component({
  selector: 'orb-campaign-page',
  imports: [Can, RouterLink, Icon, LoadError, PhaseStepper, Skeleton, StatusBadge, Term, UrlPipe],
  template: `
    @if (view.error(); as err) {
      <div class="page"><orb-load-error [error]="err" (retry)="view.reload()" /></div>
    } @else if (view.hasValue()) {
      @let v = view.value();
      <div class="page">
        <header class="page-header">
          <div>
            <p class="page-header__eyebrow">
              <a [routerLink]="['/theatres', v.theatre.id]"
                ><orb-term key="theatre">Theatre</orb-term> {{ v.theatre.name }}</a
              >
              · <orb-term key="campaign">Campaign</orb-term> · {{ v.campaign.status }}
            </p>
            <h1>Campaign {{ v.campaign.name }}</h1>
            @if (v.campaign.description) {
              <p class="page-header__lede">{{ v.campaign.description }}</p>
            }
            <p class="meta">
              {{ doneCount(v) }} of {{ v.steps.length }} step(s) done.
              @if (v.campaign.closed; as c) {
                {{ v.campaign.status === 'done' ? 'Complete' : 'Called off'
                }}{{ c.note ? ': ' + c.note : '' }}.
              }
            </p>
          </div>
          @if (v.campaign.status === 'under-way' || v.campaign.status === 'held') {
            <div class="header-actions" *orbCan="null">
              <button type="button" class="btn" (click)="callOff()">
                <orb-icon name="x" /> Call off…
              </button>
            </div>
          }
        </header>

        @if (v.campaign.status === 'held') {
          <section class="panel hold" role="status" aria-labelledby="camp-hold-h">
            <h2 id="camp-hold-h" class="panel__title">
              <orb-status status="blocked" /> Holds at step {{ v.campaign.current + 1 }}
            </h2>
            <p>{{ v.campaign.held }}</p>
            <p class="meta">
              Start the step over as a new operation, skip it, or call the campaign off.
            </p>
            <div class="actions" *orbCan="null">
              <button
                type="button"
                class="btn btn--primary"
                [disabled]="busy()"
                (click)="resume(false)"
              >
                Start the step over
              </button>
              <button type="button" class="btn" [disabled]="busy()" (click)="resume(true)">
                Skip the step
              </button>
            </div>
          </section>
        } @else if (needs(v).length) {
          <section class="panel" aria-labelledby="camp-needs-h">
            <h2 id="camp-needs-h" class="panel__title">Needs you</h2>
            <ul class="list-reset">
              @for (a of needs(v); track a.entityId + a.kind) {
                <li>
                  <a [routerLink]="a.link | url">{{ a.title }}</a>
                  @if (a.detail) {
                    <span class="meta"> — {{ a.detail }}</span>
                  }
                </li>
              }
            </ul>
          </section>
        }

        <section class="panel" aria-labelledby="camp-steps-h">
          <h2 id="camp-steps-h" class="panel__title">Steps</h2>
          <ol class="list-reset steps" aria-label="Campaign steps">
            @for (s of v.steps; track s.index) {
              <li class="step" [class.current]="s.index === v.campaign.current">
                <span class="step__n" aria-hidden="true">{{ s.index + 1 }}</span>
                <div class="step__body">
                  <h3>
                    @if (s.operation; as o) {
                      <a [routerLink]="['/operations', o.id]">Operation {{ o.name }}</a>
                    } @else {
                      {{ s.name }}
                    }
                  </h3>
                  <p class="meta"><orb-term key="intent">Intent</orb-term>: {{ s.intent }}</p>
                  @if (s.operation; as o) {
                    <orb-phase-stepper [phase]="o.phase" [compact]="true" />
                  }
                </div>
                <orb-status
                  [status]="stepStatus(s.status)"
                  [attr.aria-label]="'Step ' + (s.index + 1) + ': ' + s.status"
                />
              </li>
            }
          </ol>
        </section>
      </div>
    } @else {
      <div class="page" aria-busy="true">
        <orb-skeleton [lines]="2" />
        <orb-skeleton variant="block" [lines]="3" />
      </div>
    }
  `,
  styles: `
    .header-actions {
      display: flex;
      gap: var(--space-2);
    }
    .hold {
      border-color: var(--tone-warning);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .steps {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .step {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: var(--space-3);
      align-items: start;
      padding: var(--space-3);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-lg);
      &.current {
        border-color: var(--color-accent);
      }
      h3 {
        margin: 0;
        font-size: var(--font-size-md);
      }
    }
    .step__n {
      display: inline-grid;
      place-items: center;
      inline-size: var(--space-6);
      block-size: var(--space-6);
      border-radius: var(--radius-pill);
      background: var(--color-surface-2);
      font-weight: var(--font-weight-semibold);
    }
    .step__body {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      min-inline-size: 0;
    }
  `,
})
export class CampaignPage {
  readonly campaignId = input.required<string>();
  protected readonly view = httpResource<CampaignSummary>(() => apiUrl.campaign(this.campaignId()));
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private readonly toasts = inject(Toasts);
  protected readonly busy = signal(false);

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      crumbs.set([
        ORBAT_CRUMB,
        { label: 'Theatres', link: '/theatres', term: 'theatre' },
        { label: `Theatre ${v.theatre.name}`, link: `/theatres/${v.theatre.id}` },
        { label: `Campaign ${v.campaign.name}` },
      ]);
      title.set(`Campaign ${v.campaign.name}`);
    });
    reloadOnLive(
      (n) =>
        n.type === 'version' &&
        ['campaign', 'operation', 'mission', 'task'].includes(n.version.entityType),
      () => this.view.reload(),
    );
  }

  protected stepStatus(s: CampaignSummary['steps'][number]['status']): Status {
    return STEP_STATUS[s];
  }

  protected doneCount(v: CampaignSummary): number {
    return v.steps.filter((s) => s.status === 'done').length;
  }

  protected needs(v: CampaignSummary) {
    return v.needsYou.filter((a) => a.kind !== 'campaign');
  }

  protected async resume(skip: boolean): Promise<void> {
    this.busy.set(true);
    try {
      const c = await this.api.resumeCampaign(this.campaignId(), skip);
      this.view.reload();
      this.toasts.show({
        tone: 'success',
        message:
          c.campaign.status === 'done'
            ? `Campaign ${c.campaign.name} complete: its last step was skipped.`
            : `Step ${c.campaign.current + 1} ${skip ? 'launched' : 'started over'}.`,
      });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }

  protected callOff(): void {
    const v = this.view.value();
    if (!v) return;
    openDialog<boolean, CancelData, CancelCampaignDialog>(
      this.dialog,
      CancelCampaignDialog,
      { campaignId: v.campaign.id, name: v.campaign.name },
      `Call off Campaign ${v.campaign.name}`,
    ).closed.subscribe((done) => {
      if (!done) return;
      this.toasts.show({ tone: 'info', message: `Campaign ${v.campaign.name} called off.` });
      this.view.reload();
    });
  }
}
