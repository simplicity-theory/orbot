import { Can } from '../../ui/can';
import { Component, inject, input, output, signal } from '@angular/core';
import type { RecordEvent } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Icon } from '../../ui/icon';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

/** Latest cold-start check: could a fresh bot continue from the unit's documents alone? */
@Component({
  selector: 'orb-coldstart-card',
  imports: [Can, Icon, Term, RelativeTimePipe],
  template: `
    <section class="panel" aria-labelledby="cs-h">
      <h2 id="cs-h" class="panel__title">
        <orb-term key="cold-start">Cold-start check</orb-term>
        <button
          *orbCan="unitId()"
          type="button"
          class="btn btn--ghost run"
          [disabled]="busy()"
          (click)="run()"
        >
          <orb-icon class="sm" name="activity" /> {{ busy() ? 'Checking…' : 'Run check now' }}
        </button>
      </h2>
      @if (result(); as r) {
        <div class="score" [attr.data-pass]="r.body.score === 100">
          <span class="value">{{ r.body.score }}</span
          ><span class="of">/100</span>
          <span class="verdict">
            {{
              r.body.score === 100
                ? 'A fresh bot could carry on from the documents alone.'
                : 'A fresh bot would struggle — gaps below.'
            }}
          </span>
        </div>
        <p class="meta">
          @if (r.body.taskNumber) {
            Checked against task #{{ r.body.taskNumber }} ·
          }
          <time [attr.datetime]="r.createdAt" [attr.title]="full(r.createdAt)">{{
            r.createdAt | relativeTime
          }}</time>
        </p>
        @if (r.body.gaps.length) {
          <ul class="gaps">
            @for (g of r.body.gaps; track $index) {
              <li>{{ g }}</li>
            }
          </ul>
        }
        @if (r.body.fixes.length) {
          <p class="meta">
            <orb-icon class="sm" name="check" /> {{ r.body.fixes.length }} Field Manual fix(es)
            written by the Overseer.
          </p>
        }
      } @else {
        <p class="meta">
          No check yet. The Overseer runs one periodically; run one now to see where the documents
          stand.
        </p>
      }
    </section>
  `,
  styles: `
    .run {
      min-height: auto;
      font-size: var(--font-size-xs);
      letter-spacing: normal;
      text-transform: none;
    }
    .score {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-2);
      color: var(--tone-warning);
      &[data-pass='true'] {
        color: var(--tone-success);
      }
      .value {
        font-size: var(--font-size-3xl);
        font-weight: var(--font-weight-bold);
      }
      .verdict {
        color: var(--color-text);
      }
    }
    .gaps {
      margin: var(--space-2) 0 0;
      padding-left: var(--space-5);
    }
  `,
})
export class ColdStartCard {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly unitId = input.required<string>();
  readonly result = input<RecordEvent<'coldstart.check'> | null>(null);
  readonly ran = output<void>();
  protected readonly busy = signal(false);
  protected readonly full = fullDate;

  protected async run(): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.runColdStart(this.unitId());
      this.toasts.show({
        tone: r.body.score === 100 ? 'success' : 'info',
        message: `Cold-start check: ${r.body.score}/100.`,
        detail: r.body.gaps.length ? `${r.body.gaps.length} gap(s) found.` : 'No gaps.',
      });
      this.ran.emit();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
