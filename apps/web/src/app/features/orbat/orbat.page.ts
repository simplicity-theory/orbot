import { httpResource } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import type { OrbatView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { EmptyState } from '../../ui/empty-state';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { UnitCard } from './unit-card';

@Component({
  selector: 'orb-orbat-page',
  imports: [UnitCard, Skeleton, EmptyState, LoadError, Term],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1><orb-term key="orbat">ORBAT</orb-term></h1>
          <p class="page-header__lede">
            Every unit, who commands it, what it is doing, and anything that needs you.
          </p>
        </div>
      </header>

      @if (orbat.error(); as err) {
        <orb-load-error [error]="err" (retry)="orbat.reload()" />
      } @else if (orbat.hasValue()) {
        @let v = orbat.value();
        @if (v.units.length) {
          <ul class="grid list-reset" aria-label="Units">
            @for (u of v.units; track u.unit.id) {
              <li><orb-unit-card [unit]="u" /></li>
            }
          </ul>
        } @else {
          <orb-empty-state icon="users" title="No units yet">
            Units are the teams you command — Engineers, Logistics, Inspection, Guard. Run
            <code>npm run db:seed</code> to create the demo force.
          </orb-empty-state>
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
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(var(--card-min-width), 1fr));
      gap: var(--space-4);
    }
  `,
})
export class OrbatPage {
  protected readonly orbat = httpResource<OrbatView>(() => apiUrl.orbat());

  constructor() {
    inject(Breadcrumbs).set([{ ...ORBAT_CRUMB, link: undefined }]);
    reloadOnLive(
      (n) =>
        n.type === 'version' && ['unit', 'bot', 'task', 'mission'].includes(n.version.entityType),
      () => this.orbat.reload(),
    );
  }
}
