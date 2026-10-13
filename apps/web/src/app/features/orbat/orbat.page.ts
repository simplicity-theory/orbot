import { httpResource } from '@angular/common/http';
import { Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { OrbatView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { MainEfforts } from '../../core/main-effort';
import { MainEffortBadge } from '../../ui/main-effort';
import { OrbatTree } from './orbat-tree';
import { UnitCard } from './unit-card';

type View = 'cards' | 'tree';

@Component({
  selector: 'orb-orbat-page',
  imports: [
    UnitCard,
    OrbatTree,
    Skeleton,
    EmptyState,
    LoadError,
    Term,
    RouterLink,
    Icon,
    MainEffortBadge,
  ],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1><orb-term key="orbat">ORBAT</orb-term></h1>
          <p class="page-header__lede">
            Every unit, who commands it, what it is doing, and anything that needs you.
          </p>
        </div>
        <div class="toggle" role="group" aria-label="Layout">
          <a
            class="btn btn--ghost"
            [routerLink]="[]"
            [queryParams]="{ view: null }"
            [attr.aria-current]="view() === 'cards' ? 'true' : null"
          >
            <orb-icon name="grid" /> Cards
          </a>
          <a
            class="btn btn--ghost"
            [routerLink]="[]"
            [queryParams]="{ view: 'tree' }"
            [attr.aria-current]="view() === 'tree' ? 'true' : null"
          >
            <orb-icon name="git-branch" /> Tree
          </a>
        </div>
      </header>

      @if (efforts.view.hasValue()) {
        <p class="effort">
          @if (efforts.operation(); as op) {
            <orb-main-effort-badge />
            <a [routerLink]="['/operations', op.id]">Operation {{ op.name }}</a>
            <span class="meta">— its tasks go first. {{ efforts.current()?.reason }}</span>
          } @else {
            <span class="meta"
              >No <orb-term key="main-effort">main effort</orb-term>: work goes in queue order.
              <a routerLink="/operations">Name one from an operation</a>.</span
            >
          }
        </p>
      }

      @if (orbat.error(); as err) {
        <orb-load-error [error]="err" (retry)="orbat.reload()" />
      } @else if (orbat.hasValue()) {
        @let v = orbat.value();
        @if (!v.units.length) {
          <orb-empty-state icon="users" title="No units yet">
            Units are the teams you command — Engineers, Logistics, Inspection, Guard. Run
            <code>npm run db:seed</code> to create the demo force.
          </orb-empty-state>
        } @else if (view() === 'tree') {
          <orb-orbat-tree [units]="v.units" />
        } @else {
          <ul class="grid list-reset" aria-label="Units">
            @for (u of v.units; track u.unit.id) {
              <li><orb-unit-card [unit]="u" /></li>
            }
          </ul>
        }
      } @else {
        <ul class="grid list-reset" aria-busy="true" aria-label="Loading units">
          @for (i of [1, 2, 3, 4]; track i) {
            <li><orb-skeleton variant="block" [lines]="2" /></li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    .effort {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2);
      margin-bottom: var(--space-4);
      a {
        text-decoration: underline;
      }
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(var(--card-min-width), 1fr));
      gap: var(--space-4);
    }
    .toggle {
      display: flex;
      gap: var(--space-1);
      [aria-current='true'] {
        background: var(--color-surface-3);
        color: var(--color-text);
      }
    }
  `,
})
export class OrbatPage {
  protected readonly efforts = inject(MainEfforts);
  /** `?view=tree` — remembered in the URL so it is linkable. */
  readonly view = input<View, View | undefined>('cards', {
    transform: (v) => (v === 'tree' ? 'tree' : 'cards'),
  });
  protected readonly orbat = httpResource<OrbatView>(() => apiUrl.orbat());

  constructor() {
    inject(Breadcrumbs).set([{ ...ORBAT_CRUMB, link: undefined }]);
    reloadOnLive(
      (n) =>
        n.type === 'version' &&
        ['unit', 'bot', 'task', 'mission', 'backbrief'].includes(n.version.entityType),
      () => this.orbat.reload(),
    );
  }
}
