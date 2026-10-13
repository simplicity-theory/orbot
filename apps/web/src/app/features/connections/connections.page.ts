import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { ConnectionSupply, ConnectionView, IssueView, UnitView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Auth } from '../../core/auth';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { Can } from '../../ui/can';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

/** One connection's open issues, each one click from becoming a mission. */
@Component({
  selector: 'orb-issues',
  imports: [FormsModule, RouterLink, LoadError, Skeleton],
  template: `
    @if (issues.error(); as err) {
      <orb-load-error [error]="err" (retry)="issues.reload()" />
    } @else if (issues.value(); as list) {
      <ul class="list-reset issues" [attr.aria-label]="'Open issues on ' + name()">
        @for (i of list; track i.number) {
          <li>
            <a [href]="i.url" target="_blank" rel="noopener">#{{ i.number }} {{ i.title }}</a>
            @for (l of i.labels; track l) {
              <span class="chip">{{ l }}</span>
            }
            @if (i.taken; as t) {
              <span class="meta"
                >Taken on by <a [routerLink]="['/units', t.unitId]">{{ t.unitName }}</a></span
              >
            } @else if (units().length) {
              <span class="take">
                <label class="visually-hidden" [for]="'take-' + i.number"
                  >Unit to take on issue #{{ i.number }}</label
                >
                <select class="input" [id]="'take-' + i.number" #unit>
                  @for (u of units(); track u.id) {
                    <option [value]="u.id">{{ u.name }}</option>
                  }
                </select>
                <button
                  type="button"
                  class="btn small"
                  [disabled]="busy()"
                  (click)="take(i, unit.value)"
                >
                  Take on
                </button>
              </span>
            }
          </li>
        } @empty {
          <li class="meta">No open issues.</li>
        }
      </ul>
    } @else {
      <orb-skeleton [lines]="2" />
    }
  `,
  styles: `
    .issues {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      li {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
      }
      a {
        text-decoration: underline;
      }
    }
    .take {
      display: inline-flex;
      gap: var(--space-2);
      margin-left: auto;
    }
  `,
})
export class IssuesList {
  private readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly connectionId = input.required<string>();
  readonly name = input.required<string>();
  protected readonly busy = signal(false);
  protected readonly issues = httpResource<IssueView[]>(() => apiUrl.issues(this.connectionId()));
  private readonly allUnits = httpResource<UnitView[]>(() => apiUrl.units());
  /** Units this officer may give a mission to. */
  protected readonly units = computed(() =>
    (this.allUnits.value() ?? []).filter((u) => this.auth.can(u.id)),
  );

  protected async take(i: IssueView, unitId: string): Promise<void> {
    this.busy.set(true);
    try {
      const m = await this.api.takeIssue(this.connectionId(), unitId, i.number);
      this.issues.reload();
      this.toasts.show({
        tone: 'success',
        message: `Issue #${i.number} taken on: “${m.goal}”.`,
        detail: 'The Overseer will brief back a plan.',
      });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}

/** Connected services: pull requests ORBOT opened, pipeline results, and open issues. */
@Component({
  selector: 'orb-connections-page',
  imports: [
    Can,
    EmptyState,
    Icon,
    IssuesList,
    LoadError,
    RelativeTimePipe,
    RouterLink,
    Skeleton,
    Term,
  ],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1><orb-term key="connection">Connections</orb-term></h1>
          <p class="page-header__lede">
            The code host, issue tracker and build pipeline each repository lives with. A red
            pipeline holds production deploys.
          </p>
        </div>
        <button *orbCan="'officer'" type="button" class="btn" (click)="poll()">
          <orb-icon name="activity" /> Check pipelines now
        </button>
      </header>
      @if (view.error(); as err) {
        <orb-load-error [error]="err" (retry)="view.reload()" />
      } @else if (view.value(); as list) {
        @for (c of list; track c.supply.id) {
          @let spec = asConnection(c);
          <section class="panel" [attr.aria-label]="c.supply.name">
            <h2 class="panel__title">
              <span>{{ c.supply.name }}</span>
              <span class="meta"
                >{{ spec.owner }}/{{ spec.repo }} · for {{ c.repositoryName }}</span
              >
            </h2>
            <p class="meta">
              {{ services(spec) }}
              <button
                *orbCan="null"
                type="button"
                class="btn btn--ghost"
                [attr.aria-label]="'Disconnect ' + c.supply.name"
                (click)="disconnect(c)"
              >
                Disconnect
              </button>
            </p>
            @if (spec.services.pipeline) {
              <h3>Pipeline</h3>
              <ul class="list-reset rows">
                @for (p of c.pipelines; track p.id) {
                  <li>
                    <span class="state" [attr.data-state]="p.body.state">{{
                      label(p.body.state)
                    }}</span>
                    <span class="mono">{{ p.body.branch }}</span>
                    <span class="mono meta">{{ p.body.sha.slice(0, 10) }}</span>
                    @if (p.body.url) {
                      <a [href]="p.body.url" target="_blank" rel="noopener">Run</a>
                    }
                    <time
                      class="meta"
                      [attr.datetime]="p.createdAt"
                      [attr.title]="full(p.createdAt)"
                      >{{ p.createdAt | relativeTime }}</time
                    >
                  </li>
                } @empty {
                  <li class="meta">Nothing pushed yet.</li>
                }
              </ul>
            }
            @if (spec.services.codeHost) {
              <h3>Pull requests</h3>
              <ul class="list-reset rows">
                @for (pr of c.pullRequests; track pr.id) {
                  <li>
                    <a [href]="pr.body.url" target="_blank" rel="noopener">#{{ pr.body.number }}</a>
                    <span class="mono">{{ pr.body.branch }} → {{ pr.body.base }}</span>
                    @if (pr.operationId) {
                      <a [routerLink]="['/operations', pr.operationId]">Operation</a>
                    }
                  </li>
                } @empty {
                  <li class="meta">
                    None yet: HQ opens one when an operation's work is first integrated.
                  </li>
                }
              </ul>
            }
            @if (spec.services.issues) {
              <h3>Open issues</h3>
              <orb-issues [connectionId]="c.supply.id" [name]="c.supply.name" />
            }
            @if (c.errors.length) {
              <h3>Recent errors</h3>
              <ul class="list-reset rows">
                @for (e of c.errors; track e.id) {
                  <li class="error">{{ e.body.what }}: {{ e.body.error }}</li>
                }
              </ul>
            }
          </section>
        } @empty {
          <orb-empty-state icon="link" title="Nothing connected">
            Connect GitHub for a repository in the <a routerLink="/supply">Supply Depot</a>: pull
            requests, issues and the build pipeline.
          </orb-empty-state>
        }
      } @else {
        <orb-skeleton variant="block" [lines]="3" />
      }
    </div>
  `,
  styles: `
    orb-empty-state a {
      text-decoration: underline;
    }
    h3 {
      font-size: var(--font-size-md);
      margin: var(--space-4) 0 var(--space-2);
    }
    .rows li {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-3);
      a {
        text-decoration: underline;
      }
    }
    .state {
      font-weight: var(--font-weight-semibold);
      &[data-state='success'] {
        color: var(--tone-success);
      }
      &[data-state='failure'] {
        color: var(--tone-danger);
      }
      &[data-state='pending'] {
        color: var(--tone-warning);
      }
    }
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class ConnectionsPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly view = httpResource<ConnectionView[]>(() => apiUrl.connections());
  protected readonly full = fullDate;

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Connections', term: 'connection' }]);
    reloadOnLive(
      (n) =>
        (n.type === 'version' && n.version.entityType === 'supply') ||
        (n.type === 'event' &&
          [
            'connection.pr',
            'pipeline.status',
            'connection.error',
            'issue.taken',
            'issue.closed',
          ].includes(n.event.kind)),
      () => this.view.reload(),
      300,
    );
  }

  protected asConnection(c: ConnectionView): ConnectionSupply {
    return c.supply.spec as ConnectionSupply;
  }

  protected services(s: ConnectionSupply): string {
    return [
      s.services.codeHost && 'Code host',
      s.services.issues && 'Issue tracker',
      s.services.pipeline && 'Build pipeline',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected label(state: string): string {
    return state === 'success' ? 'Passed' : state === 'failure' ? 'Failed' : 'Running';
  }

  protected async disconnect(c: ConnectionView): Promise<void> {
    try {
      await this.api.disconnectService(c.supply.id);
      this.view.reload();
      this.toasts.show({
        tone: 'success',
        message: `${c.supply.name} disconnected.`,
        detail: 'Its history stays on the record.',
      });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    }
  }

  protected async poll(): Promise<void> {
    try {
      await this.api.pollPipelines();
      this.view.reload();
      this.toasts.show({ tone: 'success', message: 'Pipelines checked.' });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    }
  }
}
