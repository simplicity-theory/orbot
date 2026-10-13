import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { marked } from 'marked';
import type { OperationDetailView, TaskDetailView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { PageTitle } from '../../core/title';
import { Backbrief } from '../../ui/backbrief';
import { DeployApproval } from '../../ui/deploy-approval';
import { LoadError } from '../../ui/load-error';
import { PhaseStepper } from '../../ui/phase-stepper';
import { BudgetControl } from '../../ui/budget';
import { Skeleton } from '../../ui/skeleton';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';
import { RecordTimeline } from '../tasks/record-timeline';
import { MainEfforts } from '../../core/main-effort';
import { MainEffortBadge, MainEffortButton } from '../../ui/main-effort';
import { MissionChain } from './mission-chain';

@Component({
  selector: 'orb-operation-page',
  imports: [
    RouterLink,
    Backbrief,
    DeployApproval,
    LoadError,
    PhaseStepper,
    BudgetControl,
    Skeleton,
    StatusBadge,
    Term,
    RecordTimeline,
    MissionChain,
    MainEffortBadge,
    MainEffortButton,
  ],
  template: `
    @if (view.error(); as err) {
      <div class="page"><orb-load-error [error]="err" (retry)="view.reload()" /></div>
    } @else if (view.hasValue()) {
      @let v = view.value();
      <div class="page">
        <header class="page-header">
          <div>
            <p class="page-header__eyebrow">
              <orb-term key="operation">Operation</orb-term> · {{ v.operation.phase }}
            </p>
            <h1>Operation {{ v.operation.name }}</h1>
            <p class="page-header__lede">
              <orb-term key="intent">Intent</orb-term>: {{ v.operation.intent }}
            </p>
            @if (v.operation.reconTaskId) {
              <p>
                <orb-term key="recon">Recon</orb-term> first:
                @if (recon.value()?.task; as r) {
                  <a
                    [routerLink]="
                      r.botId
                        ? ['/units', r.unitId, 'bots', r.botId, 'tasks', r.id]
                        : ['/units', r.unitId, 'tasks', r.id]
                    "
                    >task #{{ r.number }}</a
                  >
                  <orb-status [status]="r.status" />
                }
              </p>
            }
            @if (efforts.isOperation(v.operation.id)) {
              <p><orb-main-effort-badge /> Its tasks go first; other work makes way for it.</p>
            }
          </div>
          @if (v.operation.phase !== 'closed') {
            <orb-main-effort-button
              [operationId]="v.operation.id"
              [name]="'Operation ' + v.operation.name"
            />
          }
        </header>
        <section class="panel" aria-label="Phase">
          <orb-phase-stepper [phase]="v.operation.phase" />
        </section>
        <section class="panel" aria-labelledby="op-budget-h">
          <h2 id="op-budget-h" class="panel__title">Compute budget</h2>
          <orb-budget-control
            scope="operation"
            [targetId]="v.operation.id"
            [name]="'Operation ' + v.operation.name"
            [budget]="v.budget"
            (changed)="view.reload()"
          />
        </section>

        @if (backbriefs().length || deploys().length) {
          <section class="panel attention" aria-labelledby="needs-h">
            <h2 id="needs-h" class="panel__title">Needs you</h2>
            @for (bb of backbriefs(); track bb.id) {
              <orb-backbrief [backbrief]="bb" (decided)="view.reload()" />
            }
            @for (d of deploys(); track d.id) {
              <div class="deploy">
                <p>
                  <strong>Production deploy</strong> — {{ d.unitName }} task #{{ d.number }}:
                  {{ d.title }}
                </p>
                <orb-deploy-approval
                  [taskId]="d.id"
                  [label]="'deploy #' + d.number"
                  (decided)="view.reload()"
                />
              </div>
            }
          </section>
        }

        <section class="panel" aria-labelledby="chain-h">
          <h2 id="chain-h" class="panel__title">
            <span>Missions, in <orb-term key="handoff">handoff</orb-term> order</span>
          </h2>
          <orb-mission-chain [missions]="v.missions" />
          <ul class="list-reset tasks">
            @for (m of v.missions; track m.mission.id) {
              @for (t of m.tasks; track t.id) {
                <li>
                  <a
                    [routerLink]="
                      t.botId
                        ? ['/units', m.unit.id, 'bots', t.botId, 'tasks', t.id]
                        : ['/units', m.unit.id, 'tasks', t.id]
                    "
                  >
                    <span class="mono">#{{ t.number }}</span> {{ t.title }}
                  </a>
                  <span class="meta">{{ m.unit.name }} · {{ t.kind }}</span>
                  <orb-status [status]="t.status" />
                </li>
              }
            }
          </ul>
          @if (v.operation.integrationBranch) {
            <p class="meta">
              Integration branch <span class="mono">{{ v.operation.integrationBranch }}</span>
            </p>
          }
          @if (v.operation.deployment; as d) {
            <p class="deployed">
              Deployed to {{ d.environment }} at
              <span class="mono">{{ d.commit.slice(0, 10) }}</span>
            </p>
          }
        </section>

        <div class="columns">
          <section class="panel" aria-labelledby="tl-h">
            <h2 id="tl-h" class="panel__title">Timeline (newest first)</h2>
            <orb-record-timeline
              [events]="v.timeline"
              [newestFirst]="true"
              label="Operation timeline"
            />
          </section>
          @if (v.afterAction; as aar) {
            <section class="panel markdown" aria-labelledby="aar-h">
              <h2 id="aar-h" class="panel__title">
                <orb-term key="after-action">After Action review</orb-term>
              </h2>
              <div [innerHTML]="md(aar.markdown)"></div>
            </section>
          }
        </div>

        @if (v.record; as rec) {
          <section class="panel markdown" aria-labelledby="rec-h">
            <h2 id="rec-h" class="panel__title">
              Shared record
              <a [routerLink]="['/archive', rec.id]">History</a>
            </h2>
            <div [innerHTML]="md(rec.markdown)"></div>
          </section>
        }
      </div>
    } @else {
      <div class="page" aria-busy="true"><orb-skeleton variant="block" [lines]="3" /></div>
    }
  `,
  styles: `
    .attention {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      border-color: var(--tone-warning);
    }
    .deploy {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .tasks {
      margin-top: var(--space-4);
      li {
        display: grid;
        grid-template-columns: minmax(0, 1fr) max-content max-content;
        align-items: center;
        gap: var(--space-3);
        min-height: var(--row-height-dense);
        border-top: var(--border-width) solid var(--color-border);
      }
    }
    .deployed {
      color: var(--tone-success);
      font-weight: var(--font-weight-semibold);
    }
    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(var(--card-min-width), 1fr));
      gap: var(--space-4);
    }
    .panel__title a {
      font-size: var(--font-size-xs);
      letter-spacing: normal;
      text-transform: none;
    }
    .markdown ::ng-deep {
      h3 {
        font-size: var(--font-size-lg);
        margin-bottom: var(--space-2);
      }
      h4 {
        font-size: var(--font-size-md);
        margin: var(--space-4) 0 var(--space-2);
      }
      ul,
      ol {
        padding-left: var(--space-5);
      }
      blockquote {
        margin: 0 0 var(--space-3);
        padding-left: var(--space-3);
        border-left: calc(var(--border-width) * 3) solid var(--color-border-strong);
        color: var(--color-text-muted);
      }
    }
  `,
})
export class OperationPage {
  protected readonly efforts = inject(MainEfforts);
  /** The recon HQ ordered before planning, if any. */
  protected readonly recon = httpResource<TaskDetailView>(() => {
    const id = this.view.value()?.operation.reconTaskId;
    return id ? apiUrl.task(id) : undefined;
  });
  readonly operationId = input.required<string>();
  protected readonly view = httpResource<OperationDetailView>(() =>
    apiUrl.operation(this.operationId()),
  );
  protected readonly backbriefs = computed(() =>
    (this.view.value()?.missions ?? []).flatMap((m) =>
      m.backbrief?.status === 'awaiting-approval' ? [m.backbrief] : [],
    ),
  );
  protected readonly deploys = computed(() =>
    (this.view.value()?.missions ?? []).flatMap((m) =>
      m.tasks
        .filter((t) => t.kind === 'deploy' && t.status === 'awaiting-approval')
        .map((t) => ({ ...t, unitName: m.unit.name })),
    ),
  );

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      crumbs.set([
        ORBAT_CRUMB,
        { label: 'Operations', link: '/operations', term: 'operation' },
        { label: `Operation ${v.operation.name}` },
      ]);
      title.set(`Operation ${v.operation.name}`);
    });
    reloadOnLive(
      (n) =>
        (n.type === 'event' && n.event.operationId === this.operationId()) ||
        (n.type === 'version' &&
          ['operation', 'mission', 'task', 'backbrief', 'document'].includes(n.version.entityType)),
      () => {
        this.view.reload();
        if (this.view.value()?.operation.reconTaskId) this.recon.reload();
      },
      200,
    );
  }

  /** Embedded documents sit under this page's h1/h2, so their headings move down two levels. */
  protected md(markdown: string): string {
    return marked.parse(markdown.replace(/^(#{1,4}) /gm, '##$1 '), { async: false });
  }
}
