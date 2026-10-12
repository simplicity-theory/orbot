import { httpResource } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { DisputeView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { NeedsYou } from '../../core/needs-you';
import { EmptyState } from '../../ui/empty-state';
import { LoadError } from '../../ui/load-error';
import { RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';
import { scrollToFragment } from '../placeholder/scroll-to-fragment';

const STATUS_LABEL: Record<DisputeView['status'], string> = {
  open: 'Open',
  ruled: 'Ruled by HQ',
  referred: 'Waiting for your ruling',
  final: 'Final',
};

/** Disputes between units: HQ's rulings under standing orders, and your final say. */
@Component({
  selector: 'orb-disputes-page',
  imports: [FormsModule, RouterLink, EmptyState, LoadError, Skeleton, Term, RelativeTimePipe],
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1><orb-term key="dispute">Disputes</orb-term></h1>
          <p class="page-header__lede">
            When units disagree, HQ rules under their standing orders and the work carries on. If no
            order settles it, it comes to you. You can overturn any ruling; yours is final.
          </p>
        </div>
      </header>

      @if (list.error(); as err) {
        <orb-load-error [error]="err" (retry)="list.reload()" />
      } @else if (list.hasValue()) {
        <ol class="list-reset stack">
          @for (d of list.value(); track d.id) {
            <li>
              <article
                class="panel dispute"
                [id]="'dispute-' + d.id"
                [attr.aria-labelledby]="'dispute-h-' + d.id"
                [attr.data-status]="d.status"
              >
                <header class="head">
                  <h2 class="panel__title" [id]="'dispute-h-' + d.id">
                    {{ d.unitName }} v {{ d.againstUnitName }}
                  </h2>
                  <span class="chip status">{{ label[d.status] }}</span>
                </header>
                <p class="meta">
                  Raised by {{ d.botCallsign ?? d.unitName }} on
                  <a [routerLink]="['/units', d.unitId, 'tasks', d.taskId]"
                    >task #{{ d.taskNumber }} {{ d.taskTitle }}</a
                  >
                  · {{ d.updatedAt | relativeTime }}
                </p>
                <blockquote class="claim">{{ d.claim }}</blockquote>

                @if (d.hqRuling; as r) {
                  <section
                    class="ruling"
                    [attr.aria-label]="'HQ ruling on ' + d.unitName + ' v ' + d.againstUnitName"
                  >
                    <h3>
                      HQ ruled:
                      {{ r.prevails === 'raiser' ? d.unitName : d.againstUnitName }} prevails
                    </h3>
                    <p>{{ r.reasoning }}</p>
                    @for (c of r.cited; track c.text) {
                      <p class="cite">Standing order: “{{ c.text }}”</p>
                    }
                  </section>
                } @else if (d.status === 'referred') {
                  <p class="ruling">HQ: no standing order settles this. It needs your ruling.</p>
                }

                @if (d.commanderRuling; as r) {
                  <section class="ruling final" aria-label="Your ruling">
                    <h3>
                      You ruled:
                      {{ r.prevails === 'raiser' ? d.unitName : d.againstUnitName }} prevails
                      (final)
                    </h3>
                    <p>{{ r.reasoning }}</p>
                  </section>
                } @else if (d.status === 'ruled' || d.status === 'referred') {
                  <form class="form decide" (ngSubmit)="$event.preventDefault()">
                    <label [for]="'why-' + d.id">Your reasoning</label>
                    <input
                      class="input"
                      [id]="'why-' + d.id"
                      [name]="'why-' + d.id"
                      [(ngModel)]="reasons[d.id]"
                      required
                    />
                    <div class="actions">
                      @for (side of sides; track side) {
                        <button
                          type="button"
                          class="btn"
                          [class.btn--primary]="d.hqRuling?.prevails === side"
                          [disabled]="busy() || !reasons[d.id]?.trim()"
                          (click)="rule(d, side)"
                        >
                          {{ buttonLabel(d, side) }}
                        </button>
                      }
                    </div>
                  </form>
                }
              </article>
            </li>
          } @empty {
            <orb-empty-state icon="users" title="No disputes">
              When one unit disagrees with another about its work, the dispute and HQ's ruling show
              here.
            </orb-empty-state>
          }
        </ol>
      } @else {
        <orb-skeleton [lines]="6" />
      }
    </div>
  `,
  styles: `
    .stack {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-3);
    }
    [data-status='referred'] .status {
      color: var(--tone-warning);
      border-color: var(--tone-warning);
    }
    .claim {
      margin: var(--space-3) 0;
      padding-left: var(--space-3);
      border-left: var(--focus-ring-width) solid var(--color-border-strong);
    }
    .ruling {
      margin-top: var(--space-3);
      h3 {
        margin: 0 0 var(--space-1);
        font-size: var(--font-size-lg);
      }
      p {
        margin: 0 0 var(--space-1);
      }
    }
    .final h3 {
      color: var(--tone-success);
    }
    .cite {
      color: var(--color-text-muted);
    }
    .decide {
      margin-top: var(--space-3);
    }
  `,
})
export class DisputesPage {
  protected readonly list = httpResource<DisputeView[]>(() => apiUrl.disputes());
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly needsYou = inject(NeedsYou);
  protected readonly label = STATUS_LABEL;
  protected readonly sides = ['raiser', 'other'] as const;
  protected readonly reasons: Record<string, string> = {};
  protected readonly busy = signal(false);

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Disputes' }]);
    scrollToFragment();
    reloadOnLive(
      (n) => n.type === 'version' && n.version.entityType === 'dispute',
      () => this.list.reload(),
    );
  }

  protected buttonLabel(d: DisputeView, side: 'raiser' | 'other'): string {
    const name = side === 'raiser' ? d.unitName : d.againstUnitName;
    if (!d.hqRuling) return `Rule for ${name}`;
    return d.hqRuling.prevails === side
      ? `Uphold HQ: ${name} prevails`
      : `Overturn: ${name} prevails`;
  }

  protected async rule(d: DisputeView, prevails: 'raiser' | 'other'): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.ruleDispute(d.id, prevails, (this.reasons[d.id] ?? '').trim());
      const name = prevails === 'raiser' ? d.unitName : d.againstUnitName;
      this.toasts.show({ tone: 'success', message: `Ruled: ${name} prevails. Final.` });
      this.list.reload();
      this.needsYou.reload();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
