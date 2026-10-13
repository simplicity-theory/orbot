import { Component, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { RecordEvent } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Icon } from '../../ui/icon';
import { RelativeTimePipe, fullDate } from '../../ui/relative-time';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';
import { UrlPipe } from '../../ui/url.pipe';

const SEVERITY = {
  blocker: { icon: 'octagon-pause', label: 'Blocker' },
  risk: { icon: 'triangle-alert', label: 'Risk' },
  note: { icon: 'info', label: 'Note' },
} as const;

/** The latest sand-table rehearsal of an operation's plan, and a button to rehearse again. */
@Component({
  selector: 'orb-sand-table',
  imports: [RouterLink, Icon, Term, RelativeTimePipe, UrlPipe],
  template: `
    <section class="panel" id="sand-table" aria-labelledby="sand-h">
      <h2 id="sand-h" class="panel__title">
        <span><orb-term key="sand-table">Sand table</orb-term></span>
        <button type="button" class="btn btn--ghost" [disabled]="busy()" (click)="rehearse()">
          <orb-icon name="activity" /> {{ result() ? 'Rehearse again' : 'Rehearse the plan' }}
        </button>
      </h2>
      @if (result(); as r) {
        <p class="verdict" [attr.data-verdict]="r.body.verdict">
          <orb-icon [name]="r.body.verdict === 'go' ? 'check' : 'octagon-pause'" />
          <strong>{{ r.body.verdict === 'go' ? 'Go' : 'No-go' }}</strong>
          <span class="meta">
            About {{ r.body.estimate.tasks }} task(s), {{ r.body.estimate.units }} compute units ·
            rehearsed
            <time [attr.datetime]="r.createdAt" [attr.title]="full(r.createdAt)">{{
              r.createdAt | relativeTime
            }}</time>
          </span>
        </p>
        <ul class="list-reset findings">
          @for (f of r.body.findings; track $index) {
            <li [attr.data-severity]="f.severity">
              <span class="sev"
                ><orb-icon [name]="sev[f.severity].icon" /> {{ sev[f.severity].label }}</span
              >
              <div>
                <p>{{ f.text }}</p>
                @if (f.fix) {
                  <p class="meta">
                    @if (f.link) {
                      <a [routerLink]="f.link | url">{{ f.fix }}</a>
                    } @else {
                      {{ f.fix }}
                    }
                  </p>
                }
              </div>
            </li>
          } @empty {
            <li class="meta">Nothing in the way.</li>
          }
        </ul>
      } @else {
        <p class="meta">
          HQ rehearses the plan once the missions are issued: each mission is walked against the
          units' bots, orders, supply and budgets, before the work is done for real.
        </p>
      }
    </section>
  `,
  styles: `
    .verdict {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      &[data-verdict='go'] strong {
        color: var(--tone-success);
      }
      &[data-verdict='no-go'] strong {
        color: var(--tone-danger);
      }
    }
    .findings {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      margin-top: var(--space-3);
      li {
        display: grid;
        grid-template-columns: var(--sev-col-width) 1fr;
        gap: var(--space-3);
      }
      a {
        text-decoration: underline;
      }
    }
    .sev {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      font-weight: var(--font-weight-semibold);
      font-size: var(--font-size-sm);
    }
    [data-severity='blocker'] .sev {
      color: var(--tone-danger);
    }
    [data-severity='risk'] .sev {
      color: var(--tone-warning);
    }
    [data-severity='note'] .sev {
      color: var(--tone-info);
    }
  `,
})
export class SandTable {
  readonly operationId = input.required<string>();
  readonly result = input.required<RecordEvent<'sand-table'> | null>();
  readonly rehearsed = output<void>();

  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly busy = signal(false);
  protected readonly sev = SEVERITY;
  protected readonly full = fullDate;

  protected async rehearse(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.rehearse(this.operationId());
      this.rehearsed.emit();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
