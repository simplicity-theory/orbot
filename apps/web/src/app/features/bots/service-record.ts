import { httpResource } from '@angular/common/http';
import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ServiceRecordView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { reloadOnLive } from '../../core/live';
import { Icon } from '../../ui/icon';
import type { IconName } from '../../ui/icons';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { UrlPipe } from '../../ui/url.pipe';

const ICON: Record<string, IconName> = {
  enlisted: 'user',
  runtime: 'sliders',
  done: 'check',
  failed: 'triangle-alert',
  escalation: 'arrow-right',
  dispute: 'users',
  refusal: 'shield',
  'stood-down': 'octagon-pause',
  commendation: 'book',
};

/** A bot's service record: what it has done and how, from the permanent record. */
@Component({
  selector: 'orb-service-record',
  imports: [RouterLink, Icon, LoadError, RelativeTimePipe, Skeleton, Term, UrlPipe],
  template: `
    <section class="panel" aria-label="Service record">
      <h2 id="service-h" class="panel__title">
        <orb-term key="service-record">Service record</orb-term>
      </h2>
      @if (record.error(); as err) {
        <orb-load-error [error]="err" (retry)="record.reload()" />
      } @else if (record.value(); as r) {
        <p class="meta">
          Joined {{ r.unitName }}
          <time [attr.datetime]="r.enlisted.at" [attr.title]="full(r.enlisted.at)">{{
            r.enlisted.at | relativeTime
          }}</time>
          @if (r.replaces; as x) {
            · replaced
            <a [routerLink]="['/units', r.bot.unitId, 'bots', x.id]" class="mono">{{
              x.callsign
            }}</a>
          }
          @if (r.replacedBy; as x) {
            · replaced by
            <a [routerLink]="['/units', r.bot.unitId, 'bots', x.id]" class="mono">{{
              x.callsign
            }}</a>
          }
        </p>
        <dl class="stats">
          <div>
            <dt>Runs</dt>
            <dd>{{ r.stats.runs }}</dd>
          </div>
          <div>
            <dt>Done</dt>
            <dd>{{ r.stats.outcomes.done }}</dd>
          </div>
          <div>
            <dt>Failed or blocked</dt>
            <dd>{{ r.stats.outcomes.failed + r.stats.outcomes.blocked }}</dd>
          </div>
          <div>
            <dt>Success rate</dt>
            <dd>{{ r.stats.successRate === null ? '—' : percent(r.stats.successRate) }}</dd>
          </div>
          <div>
            <dt>Average run</dt>
            <dd>
              {{ r.stats.averageRunSeconds === null ? '—' : r.stats.averageRunSeconds + ' s' }}
            </dd>
          </div>
          <div>
            <dt>Compute spent</dt>
            <dd>{{ r.stats.unitsSpent }} units</dd>
          </div>
          <div>
            <dt><orb-term key="handover">Handovers</orb-term></dt>
            <dd>{{ r.stats.handovers }}</dd>
          </div>
          <div>
            <dt>Refused by policy</dt>
            <dd>{{ r.stats.refusals }}</dd>
          </div>
          <div>
            <dt><orb-term key="escalation">Escalations</orb-term></dt>
            <dd>{{ r.stats.escalations }}</dd>
          </div>
          <div>
            <dt><orb-term key="commendation">Commendations</orb-term></dt>
            <dd>{{ r.commendations.length }}</dd>
          </div>
        </dl>
        <ol class="list-reset entries" aria-label="Service record entries">
          @for (e of r.entries; track $index) {
            <li>
              <orb-icon class="sm" [name]="icon(e.kind)" />
              <span>
                @if (e.link) {
                  <a [routerLink]="e.link | url">{{ e.text }}</a>
                } @else {
                  {{ e.text }}
                }
              </span>
              <time class="meta" [attr.datetime]="e.at" [attr.title]="full(e.at)">{{
                e.at | relativeTime
              }}</time>
            </li>
          }
        </ol>
        <p class="meta">
          Kept for the record. It never goes into a brief: what a bot knows belongs to its unit.
        </p>
      } @else {
        <orb-skeleton variant="block" [lines]="3" />
      }
    </section>
  `,
  styles: `
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(var(--stat-min-width), 1fr));
      gap: var(--space-3);
      margin: var(--space-3) 0;
      dt {
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }
      dd {
        margin: 0;
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
      }
    }
    .entries {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      li {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: var(--space-2);
        align-items: baseline;
      }
    }
  `,
})
export class ServiceRecord {
  readonly botId = input.required<string>();
  protected readonly record = httpResource<ServiceRecordView>(() =>
    apiUrl.serviceRecord(this.botId()),
  );
  protected readonly full = fullDate;

  constructor() {
    reloadOnLive(
      (n) => n.type === 'event' && n.event.botId === this.botId(),
      () => this.record.reload(),
      500,
    );
  }

  protected icon(kind: string): IconName {
    return ICON[kind] ?? 'circle';
  }

  protected percent(x: number): string {
    return `${Math.round(x * 100)}%`;
  }
}
