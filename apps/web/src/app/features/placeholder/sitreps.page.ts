import { HttpParams, httpResource } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import type { RecordEvent } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { EmptyState } from '../../ui/empty-state';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { RecordTimeline } from '../tasks/record-timeline';

@Component({
  selector: 'orb-sitreps-page',
  imports: [EmptyState, LoadError, Skeleton, Term, RecordTimeline],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1><orb-term key="sitrep">Sitreps</orb-term></h1>
          <p class="page-header__lede">
            Situation reports from bots, units and HQ, newest first. Updates live.
          </p>
        </div>
      </header>
      @if (feed.error(); as err) {
        <orb-load-error [error]="err" (retry)="feed.reload()" />
      } @else if (feed.hasValue()) {
        @if (feed.value().length) {
          <section class="panel">
            <orb-record-timeline [events]="feed.value()" [newestFirst]="true" label="Sitreps" />
          </section>
        } @else {
          <orb-empty-state icon="radio" title="No sitreps yet"
            >Bots report progress here as they work.</orb-empty-state
          >
        }
      } @else {
        <orb-skeleton [lines]="8" />
      }
    </div>
  `,
})
export class SitrepsPage {
  protected readonly feed = httpResource<RecordEvent[]>(() => ({
    url: apiUrl.events(),
    params: new HttpParams().set('kinds', 'sitrep').set('limit', 1000),
  }));
  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Sitreps', term: 'sitrep' }]);
    reloadOnLive(
      (n) => n.type === 'event' && n.event.kind === 'sitrep',
      () => this.feed.reload(),
    );
  }
}
