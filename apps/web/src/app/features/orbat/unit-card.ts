import { Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { STATUS_META, type BotStatus, type OrbatUnit } from '@orbot/shared';
import { Backbrief } from '../../ui/backbrief';
import { BudgetMeter } from '../../ui/budget';
import { Icon } from '../../ui/icon';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';

const ATTENTION_ICON = {
  'blocked-bot': 'octagon-pause',
  'failed-task': 'triangle-alert',
  'awaiting-approval': 'stamp',
  escalation: 'arrow-right',
  budget: 'coins',
} as const;

/** A unit at a glance, with an attention strip of everything that needs the Commander. */
@Component({
  selector: 'orb-unit-card',
  imports: [RouterLink, Icon, StatusBadge, Term, Backbrief, BudgetMeter],
  template: `
    @let u = unit();
    <article class="card" [attr.aria-labelledby]="'unit-' + u.unit.id">
      <header>
        <div>
          <h2 [id]="'unit-' + u.unit.id">
            <a [routerLink]="['/units', u.unit.id]">{{ u.unit.name }}</a>
          </h2>
          <p class="meta">{{ u.unit.role }}</p>
        </div>
        <orb-status [status]="u.status" />
      </header>

      <dl class="facts">
        <div>
          <dt><orb-term key="overseer">Overseer</orb-term></dt>
          <dd>
            @if (u.overseer; as o) {
              <a class="mono" [routerLink]="['/units', u.unit.id, 'bots', o.id]">{{
                o.callsign
              }}</a>
            } @else {
              <span class="meta">None assigned</span>
            }
          </dd>
        </div>
        <div>
          <dt>Bots</dt>
          <dd>
            {{ u.botCount }}
            @for (s of statusCounts(); track s.status) {
              <span class="chip" [attr.title]="s.label"
                >{{ s.count }} {{ s.label.toLowerCase() }}</span
              >
            }
          </dd>
        </div>
        <div class="wide">
          <dt><orb-term key="mission">Mission</orb-term></dt>
          <dd>{{ u.currentMission?.goal ?? u.unit.standingMission }}</dd>
        </div>
        <div class="wide">
          <dt>Budget</dt>
          <dd><orb-budget [budget]="u.budget" [label]="'Compute budget of ' + u.unit.name" /></dd>
        </div>
      </dl>

      @if (u.attention.length) {
        <section class="attention" [attr.aria-label]="'Needs you in ' + u.unit.name">
          <h3><orb-icon class="sm" name="inbox" /> Needs you ({{ u.attention.length }})</h3>
          <ul class="list-reset">
            @for (a of u.attention; track a.entityId + a.kind) {
              @let bb = backbriefFor(a.entityId);
              <li [attr.data-kind]="a.kind">
                <orb-icon class="sm" [name]="icons[a.kind]" />
                @if (bb) {
                  <span class="label">{{ a.label }}</span>
                  <button
                    type="button"
                    class="btn btn--ghost review"
                    [attr.aria-expanded]="reviewing() === bb.id"
                    [attr.aria-controls]="'review-' + bb.id"
                    (click)="reviewing.set(reviewing() === bb.id ? null : bb.id)"
                  >
                    {{ reviewing() === bb.id ? 'Close' : 'Review' }}
                  </button>
                } @else {
                  <a [routerLink]="a.link">{{ a.label }}</a>
                }
              </li>
              @if (bb && reviewing() === bb.id) {
                <li class="inline-review" [id]="'review-' + bb.id">
                  <orb-backbrief [backbrief]="bb" (decided)="reviewing.set(null)" />
                </li>
              }
            }
          </ul>
        </section>
      } @else {
        <p class="all-clear meta"><orb-icon class="sm" name="check" /> Nothing needs you here.</p>
      }
    </article>
  `,
  styles: `
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      height: 100%;
      padding: var(--space-5);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: var(--color-surface-1);
      transition: border-color var(--duration) var(--ease);
      &:hover {
        border-color: var(--color-border-strong);
      }
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--space-3);
    }
    h2 {
      font-size: var(--font-size-lg);
      a {
        color: var(--color-text);
      }
    }
    .facts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
      margin: 0;
      dt {
        color: var(--color-text-subtle);
        font-size: var(--font-size-xs);
      }
      dd {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-1);
        margin: 0;
      }
      .wide {
        grid-column: 1 / -1;
      }
    }
    .attention {
      margin-top: auto;
      padding: var(--space-3);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--tone-warning) 10%, transparent);
      h3 {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-bottom: var(--space-2);
        color: var(--tone-warning);
        font-size: var(--font-size-sm);
      }
      ul {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      li {
        display: flex;
        align-items: flex-start;
        gap: var(--space-2);
        font-size: var(--font-size-sm);
        orb-icon {
          margin-top: var(--space-1);
          color: var(--tone-warning);
        }
      }
      .label {
        flex: 1;
      }
      .review {
        min-height: auto;
        padding: 0 var(--space-2);
        font-size: var(--font-size-xs);
      }
      .inline-review {
        display: block;
        margin-top: var(--space-2);
        padding: var(--space-3);
        border-radius: var(--radius-md);
        background: var(--color-surface-1);
      }
      li[data-kind='failed-task'] orb-icon {
        color: var(--tone-danger);
      }
      a {
        color: var(--color-text);
        text-decoration: underline;
        text-decoration-color: var(--color-border-strong);
      }
    }
    .all-clear {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-top: auto;
    }
  `,
})
export class UnitCard {
  readonly unit = input.required<OrbatUnit>();
  /** Backbrief being reviewed inline, if any. */
  protected readonly reviewing = signal<string | null>(null);
  protected backbriefFor(entityId: string) {
    return this.unit().backbriefs.find((b) => b.id === entityId) ?? null;
  }
  protected readonly icons = ATTENTION_ICON;
  protected readonly statusCounts = computed(() =>
    (Object.entries(this.unit().botsByStatus) as [BotStatus, number][])
      .filter(([, n]) => n > 0)
      .map(([status, count]) => ({ status, count, label: STATUS_META[status].label })),
  );
}
