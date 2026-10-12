import { httpResource } from '@angular/common/http';
import { Component, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { BotDetailView, TaskView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive, touchedIds } from '../../core/live';
import { PageTitle } from '../../core/title';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';
import { RecordTimeline } from '../tasks/record-timeline';

@Component({
  selector: 'orb-bot-page',
  imports: [RouterLink, StatusBadge, Skeleton, LoadError, Term, RecordTimeline],
  template: `
    @if (view.error(); as err) {
      <div class="page"><orb-load-error [error]="err" (retry)="view.reload()" /></div>
    } @else if (view.hasValue()) {
      @let v = view.value();
      <div class="page page--detail">
        <header class="page-header">
          <div>
            <p class="page-header__eyebrow">
              Bot · {{ v.unit.name }}
              @if (v.bot.isOverseer) {
                · <orb-term key="overseer">Overseer</orb-term>
              }
            </p>
            <h1 class="mono">{{ v.bot.callsign }}</h1>
            <p class="page-header__lede">
              {{ v.bot.role }} · runtime <span class="mono">{{ v.bot.runtime }}</span>
            </p>
          </div>
          <orb-status [status]="v.bot.status" />
        </header>

        <section class="panel" aria-labelledby="current-h">
          <h2 id="current-h" class="panel__title">Current task</h2>
          @if (v.currentTask; as t) {
            <div class="row">
              <a [routerLink]="taskLink(t)">#{{ t.number }} {{ t.title }}</a>
              <orb-status [status]="t.status" />
            </div>
            @if (t.statusReason) {
              <p class="meta">{{ t.statusReason }}</p>
            }
          } @else {
            <p class="meta">Idle — nothing in hand.</p>
          }
        </section>

        <section class="panel" aria-labelledby="queue-h">
          <h2 id="queue-h" class="panel__title">Queue ({{ v.queue.length }})</h2>
          @for (t of v.queue; track t.id) {
            <div class="row">
              <a [routerLink]="taskLink(t)">#{{ t.number }} {{ t.title }}</a>
              <orb-status [status]="t.status" />
            </div>
          } @empty {
            <p class="meta">Queue is empty.</p>
          }
        </section>

        <section class="panel" aria-labelledby="history-h">
          <h2 id="history-h" class="panel__title">Recent history</h2>
          @for (t of v.history; track t.id) {
            <div class="row">
              <a [routerLink]="taskLink(t)">#{{ t.number }} {{ t.title }}</a>
              <orb-status [status]="t.status" />
            </div>
          } @empty {
            <p class="meta">No finished tasks yet.</p>
          }
        </section>

        <section class="panel" aria-labelledby="activity-h">
          <h2 id="activity-h" class="panel__title">Working record (latest first)</h2>
          <orb-record-timeline [events]="v.recent" label="Recent working record" />
        </section>
      </div>
    } @else {
      <div class="page page--detail" aria-busy="true">
        <orb-skeleton [lines]="2" />
        <orb-skeleton variant="block" [lines]="2" />
      </div>
    }
  `,
  styles: `
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-3);
      min-height: var(--row-height-dense);
      border-top: var(--border-width) solid var(--color-border);
    }
  `,
})
export class BotPage {
  readonly unitId = input.required<string>();
  readonly botId = input.required<string>();
  protected readonly view = httpResource<BotDetailView>(() => apiUrl.bot(this.botId()));

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      crumbs.set([
        ORBAT_CRUMB,
        { label: v.unit.name, link: `/units/${v.unit.id}` },
        { label: `Bot ${v.bot.callsign}` },
      ]);
      title.set(`Bot ${v.bot.callsign}`);
    });
    reloadOnLive(
      (n) => touchedIds(n).includes(this.botId()),
      () => this.view.reload(),
    );
  }

  protected taskLink(t: TaskView): string[] {
    return ['/units', t.unitId, 'bots', this.botId(), 'tasks', t.id];
  }
}
