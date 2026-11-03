import { Can } from '../../ui/can';
import { Dialog } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { OperationSummary } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { openDialog } from '../../ui/dialog';
import { EmptyState } from '../../ui/empty-state';
import { LoadError } from '../../ui/load-error';
import { PhaseStepper } from '../../ui/phase-stepper';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { IntentDialog } from './intent.dialog';
import { NewProjectDialog } from './new-project.dialog';
import { MainEfforts } from '../../core/main-effort';
import { MainEffortBadge } from '../../ui/main-effort';
import { MissionChain } from './mission-chain';

/** The operations board: every operation, its phase, and progress by mission. */
@Component({
  selector: 'orb-operations-page',
  imports: [
    Can,
    RouterLink,
    EmptyState,
    LoadError,
    Skeleton,
    Term,
    PhaseStepper,
    MissionChain,
    MainEffortBadge,
  ],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1><orb-term key="operation">Operations</orb-term></h1>
          <p class="page-header__lede">
            Each operation runs from your intent through HQ to every unit involved.
          </p>
        </div>
        <div *orbCan="null" class="buttons">
          <button type="button" class="btn" (click)="newProject()">New project</button>
          <button type="button" class="btn btn--primary" (click)="stateIntent()">
            State intent
          </button>
        </div>
      </header>
      @if (ops.error(); as err) {
        <orb-load-error [error]="err" (retry)="ops.reload()" />
      } @else if (ops.hasValue()) {
        <ul class="list-reset board">
          @for (o of ops.value(); track o.operation.id) {
            <li class="panel op" [attr.aria-labelledby]="'op-' + o.operation.id">
              <header>
                <h2 [id]="'op-' + o.operation.id">
                  <a [routerLink]="['/operations', o.operation.id]"
                    >Operation {{ o.operation.name }}</a
                  >
                </h2>
                @if (efforts.isOperation(o.operation.id)) {
                  <orb-main-effort-badge />
                }
                @if (o.needsYou.length) {
                  <a class="needs" [routerLink]="['/operations', o.operation.id]"
                    >{{ o.needsYou.length }} need you</a
                  >
                }
              </header>
              <p class="meta"><orb-term key="intent">Intent</orb-term>: {{ o.operation.intent }}</p>
              <orb-phase-stepper [phase]="o.operation.phase" [compact]="true" />
              @if (o.missions.length) {
                <orb-mission-chain [missions]="o.missions" />
              }
            </li>
          } @empty {
            <orb-empty-state icon="flag" title="No operations yet">
              State your <orb-term key="intent">intent</orb-term> to launch one: what you want
              achieved and why. HQ will split it into missions for the units involved.
              <div actions>
                <button
                  *orbCan="null"
                  type="button"
                  class="btn btn--primary"
                  (click)="stateIntent()"
                >
                  State intent
                </button>
              </div>
            </orb-empty-state>
          }
        </ul>
      } @else {
        <orb-skeleton variant="block" [lines]="2" />
      }
    </div>
  `,
  styles: `
    .buttons {
      display: inline-flex;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .board {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .op {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      header {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
      }
      h2 {
        margin-right: auto;
        font-size: var(--font-size-lg);
      }
    }
    .needs {
      color: var(--tone-warning);
      font-weight: var(--font-weight-semibold);
    }
  `,
})
export class OperationsPage {
  private readonly dialog = inject(Dialog);
  protected readonly efforts = inject(MainEfforts);
  protected readonly ops = httpResource<OperationSummary[]>(() => apiUrl.operations());

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Operations', term: 'operation' }]);
    reloadOnLive(
      (n) =>
        (n.type === 'version' &&
          ['operation', 'mission', 'task', 'backbrief'].includes(n.version.entityType)) ||
        (n.type === 'event' && !!n.event.operationId),
      () => this.ops.reload(),
      300,
    );
  }

  protected stateIntent(): void {
    openDialog(this.dialog, IntentDialog, null, 'State intent');
  }

  protected newProject(): void {
    openDialog(this.dialog, NewProjectDialog, null, 'New project');
  }
}
