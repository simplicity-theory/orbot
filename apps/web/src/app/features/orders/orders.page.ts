import { HttpParams, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { OrdersLogEntryView, UnitView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

/** Every change made from chat, with the message that caused it. Undo appends a reversing entry. */
@Component({
  selector: 'orb-orders-page',
  imports: [RouterLink, EmptyState, Icon, LoadError, Skeleton, Term, RelativeTimePipe],
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1><orb-term key="orders-log">Orders log</orb-term></h1>
          <p class="page-header__lede">
            Every change made from chat, linked to the message that caused it. Nothing is removed:
            Undo adds a reversing entry.
          </p>
        </div>
        <div>
          <label for="orders-unit" class="visually-hidden">Filter by unit</label>
          <select
            id="orders-unit"
            class="input"
            [value]="unitId() ?? ''"
            (change)="filter($any($event.target).value)"
          >
            <option value="">All units</option>
            @for (u of units(); track u.id) {
              <option [value]="u.id" [selected]="u.id === unitId()">{{ u.name }}</option>
            }
          </select>
        </div>
      </header>

      @if (log.error(); as err) {
        <orb-load-error [error]="err" (retry)="log.reload()" />
      } @else if (log.hasValue()) {
        <ol class="list-reset entries">
          @for (l of log.value(); track l.entry.id) {
            <li
              class="panel entry"
              [id]="'entry-' + l.entry.id"
              [class.highlight]="entry() === l.entry.id"
              [class.undone]="l.reversedBy"
            >
              <div class="head">
                <span class="chip">{{ l.unitName }}</span>
                <span class="chip kind">{{ l.entry.body.action.kind }}</span>
                @if (l.entry.body.routedVia) {
                  <span class="chip">via HQ</span>
                }
                @if (l.entry.body.reverses) {
                  <span class="chip">Undo of an earlier entry</span>
                }
                @if (l.reversedBy) {
                  <a class="chip" [routerLink]="[]" [queryParams]="{ entry: l.reversedBy }"
                    >Undone</a
                  >
                }
                <time
                  class="meta"
                  [attr.datetime]="l.entry.createdAt"
                  [attr.title]="full(l.entry.createdAt)"
                  >{{ l.entry.createdAt | relativeTime }}</time
                >
              </div>
              <p class="summary">{{ l.entry.body.summary }}</p>
              @if (l.message; as m) {
                <p class="meta">
                  From your message
                  <a [routerLink]="['/chat', m.body.channel]" [queryParams]="{ m: m.id }"
                    >“{{ m.body.text }}”</a
                  >
                </p>
              }
              <p class="links">
                @for (k of l.entry.body.links; track k.link + k.label) {
                  <a [routerLink]="k.link.split('?')[0]" [queryParams]="params(k.link)">{{
                    k.label
                  }}</a>
                }
              </p>
              @if (l.entry.body.inverse && !l.reversedBy) {
                <button type="button" class="btn small" [disabled]="busy()" (click)="undo(l)">
                  <orb-icon class="sm" name="undo" /> Undo
                </button>
              }
            </li>
          } @empty {
            <orb-empty-state icon="book" title="No orders from chat yet">
              Give an order in chat — the chat button in the header, or press <kbd>c</kbd>. Every
              change it makes is listed here.
            </orb-empty-state>
          }
        </ol>
      } @else {
        <orb-skeleton variant="block" [lines]="3" />
      }
    </div>
  `,
  styles: `
    .entries {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .entry {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      &.highlight {
        box-shadow: 0 0 0 var(--focus-ring-width) var(--color-focus);
      }
      &.undone .summary {
        text-decoration: line-through;
        color: var(--color-text-muted);
      }
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      time {
        margin-left: auto;
      }
    }
    .kind {
      font-family: var(--font-mono);
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      font-size: var(--font-size-sm);
    }
    .small {
      align-self: flex-start;
      min-height: auto;
      padding: var(--space-1) var(--space-2);
    }
  `,
})
export class OrdersPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  readonly unitId = input<string>();
  /** `?entry=` deep-links one entry. */
  readonly entry = input<string>();
  protected readonly log = httpResource<OrdersLogEntryView[]>(() => ({
    url: apiUrl.orders(),
    params: this.unitId() ? new HttpParams().set('unitId', this.unitId()!) : new HttpParams(),
  }));
  private readonly unitList = httpResource<UnitView[]>(() => apiUrl.units());
  protected readonly units = computed(() => this.unitList.value() ?? []);
  protected readonly busy = signal(false);
  protected readonly full = fullDate;

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Orders log', term: 'orders-log' }]);
    reloadOnLive(
      (n) => n.type === 'event' && n.event.kind === 'orders.log',
      () => this.log.reload(),
    );
  }

  protected params(link: string): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(link.split('?')[1] ?? ''));
  }

  protected filter(unitId: string): void {
    void this.router.navigate([], { queryParams: { unitId: unitId || null, entry: null } });
  }

  protected async undo(l: OrdersLogEntryView): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.undoOrder(l.entry.id);
      this.toasts.show({
        tone: 'success',
        message: `Undone: ${l.entry.body.summary}`,
        detail: r.summary,
      });
      this.log.reload();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
