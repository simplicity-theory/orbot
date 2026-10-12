import { httpResource } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DeconflictionView, RecordEvent, TaskStatus, Toucher } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { StatusBadge } from '../../ui/status-badge';

/** HQ's map of who touches what: every file active work changes, overlaps first. */
@Component({
  selector: 'orb-deconfliction-page',
  imports: [RouterLink, EmptyState, Icon, LoadError, Skeleton, StatusBadge, RelativeTimePipe],
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1>Deconfliction</h1>
          <p class="page-header__lede">
            Every task works in its own workspace, on its own branch. HQ tracks which files active
            work changes, and tells both bots when two tasks change the same file.
          </p>
        </div>
      </header>

      @if (view.error(); as err) {
        <orb-load-error [error]="err" (retry)="view.reload()" />
      } @else if (view.hasValue()) {
        @let v = view.value();
        <section class="panel" aria-labelledby="overlap-h">
          <h2 id="overlap-h" class="panel__title">
            <span><orb-icon name="git-branch" /> Overlaps</span>
            <span class="count" [class.hot]="v.overlaps > 0">{{ v.overlaps }}</span>
          </h2>
          @if (v.notices.length) {
            <ol class="list-reset notices">
              @for (n of notices(v.notices); track n.id) {
                <li>
                  <time class="meta" [attr.datetime]="n.createdAt">{{
                    n.createdAt | relativeTime
                  }}</time>
                  <span>
                    @for (p of n.body.paths; track p) {
                      <code>{{ p }}</code>
                    }
                    changed by {{ n.body.taskIds.length }} tasks — both bots were told.
                  </span>
                </li>
              }
            </ol>
          } @else {
            <p class="meta">No two active tasks have changed the same file.</p>
          }
        </section>

        @for (r of v.repos; track r.id) {
          <section class="panel" [attr.aria-labelledby]="'repo-' + r.id">
            <h2 class="panel__title" [id]="'repo-' + r.id">
              <span class="mono">{{ r.name }}</span>
            </h2>
            <table class="table">
              <caption class="visually-hidden">
                Files changed by active work in
                {{
                  r.name
                }}
              </caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Changed by</th>
                </tr>
              </thead>
              <tbody>
                @for (f of r.files; track f.path) {
                  <tr [class.overlap]="f.tasks.length > 1">
                    <td class="mono path">
                      @if (f.tasks.length > 1) {
                        <span class="visually-hidden">Overlap: </span>
                      }
                      {{ f.path }}
                    </td>
                    <td>
                      <ul class="list-reset who">
                        @for (t of f.tasks; track t.taskId) {
                          <li>
                            <a [routerLink]="link(t)">#{{ t.number }} {{ t.title }}</a>
                            <span class="meta"
                              >{{ t.unitName }}{{ t.callsign ? ' · ' + t.callsign : '' }} ·
                              <span class="mono">{{ t.branch }}</span></span
                            >
                            <orb-status [status]="status(t)" [compact]="true" />
                          </li>
                        }
                      </ul>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        } @empty {
          <orb-empty-state icon="git-branch" title="No active work has changed any files">
            When bots change files, each file and the task changing it is listed here.
          </orb-empty-state>
        }
      } @else {
        <orb-skeleton [lines]="6" />
      }
    </div>
  `,
  styles: `
    .count {
      font-variant-numeric: tabular-nums;
      color: var(--color-text-muted);
      &.hot {
        color: var(--tone-warning);
        font-weight: var(--font-weight-semibold);
      }
    }
    .notices li {
      display: flex;
      gap: var(--space-3);
      align-items: baseline;
      padding: var(--space-2) 0;
      code {
        margin-right: var(--space-1);
      }
    }
    .table {
      width: 100%;
      border-collapse: collapse;
      th,
      td {
        padding: var(--space-2) var(--space-3);
        text-align: left;
        vertical-align: top;
        border-top: var(--border-width) solid var(--color-border);
      }
      th {
        color: var(--color-text-muted);
        font-weight: var(--font-weight-medium);
      }
    }
    tr.overlap .path {
      color: var(--tone-warning);
      font-weight: var(--font-weight-semibold);
      border-left: var(--focus-ring-width) solid var(--tone-warning);
    }
    .path {
      word-break: break-all;
    }
    .who li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      min-height: var(--row-height-dense);
      a {
        display: inline-block;
        padding-block: var(--space-1);
      }
    }
  `,
})
export class DeconflictionPage {
  protected readonly view = httpResource<DeconflictionView>(() => apiUrl.deconfliction());

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Deconfliction' }]);
    reloadOnLive(
      (n) =>
        (n.type === 'event' && ['artifact', 'deconfliction'].includes(n.event.kind)) ||
        (n.type === 'version' && n.version.entityType === 'task'),
      () => this.view.reload(),
      500,
    );
  }

  protected notices(events: RecordEvent[]) {
    return [...(events as RecordEvent<'deconfliction'>[])].reverse();
  }

  protected link(t: Toucher): unknown[] {
    return t.botId
      ? ['/units', t.unitId, 'bots', t.botId, 'tasks', t.taskId]
      : ['/units', t.unitId, 'tasks', t.taskId];
  }

  protected status(t: Toucher): TaskStatus {
    return t.status as TaskStatus;
  }
}
