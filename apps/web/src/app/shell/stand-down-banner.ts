import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { StandDowns } from '../core/stand-down';
import { Icon } from '../ui/icon';
import { RelativeTimePipe } from '../ui/relative-time';
import { StandDownButton } from '../ui/stand-down';

/** On every screen while a stand-down order is in force: what is halted, why, and Resume. */
@Component({
  selector: 'orb-stand-down-banner',
  imports: [Icon, RouterLink, RelativeTimePipe, StandDownButton],
  template: `
    @if (sd.any()) {
      <section class="banner" aria-label="Stand-down orders in force">
        <orb-icon name="octagon-pause" />
        <ul class="list-reset">
          @if (sd.all(); as all) {
            <li>
              <strong>All units stood down</strong>: {{ all.reason }}
              <span class="meta">· {{ all.at | relativeTime }}</span>
              <orb-stand-down scope="all" name="all units" />
            </li>
          }
          @for (u of sd.units(); track u.id) {
            <li>
              <a [routerLink]="['/units', u.id]"
                ><strong>{{ u.name }}</strong></a
              >
              stood down: {{ u.halt.reason }}
              <span class="meta">· {{ u.halt.at | relativeTime }}</span>
              <orb-stand-down scope="unit" [targetId]="u.id" [name]="u.name" />
            </li>
          }
          @for (b of sd.bots(); track b.id) {
            <li>
              <a class="mono" [routerLink]="['/units', b.unitId, 'bots', b.id]"
                ><strong>{{ b.callsign }}</strong></a
              >
              stood down: {{ b.halt.reason }}
              <span class="meta">· {{ b.halt.at | relativeTime }}</span>
              <orb-stand-down scope="bot" [targetId]="b.id" [name]="b.callsign" />
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: `
    .banner {
      display: flex;
      gap: var(--space-3);
      align-items: flex-start;
      padding: var(--space-2) var(--space-4);
      border-bottom: var(--border-width) solid var(--tone-warning);
      background: var(--color-surface-2);
      color: var(--color-text);
      orb-icon {
        color: var(--tone-warning);
        margin-top: var(--space-2);
      }
    }
    li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      min-height: var(--row-height-dense);
    }
    .meta {
      color: var(--color-text-muted);
    }
  `,
})
export class StandDownBanner {
  protected readonly sd = inject(StandDowns);
}
