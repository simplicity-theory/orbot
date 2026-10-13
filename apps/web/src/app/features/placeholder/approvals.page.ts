import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { NeedsYou } from '../../core/needs-you';
import { Backbrief } from '../../ui/backbrief';
import { Acknowledge } from '../../ui/acknowledge';
import { UrlPipe } from '../../ui/url.pipe';
import { DeployApproval } from '../../ui/deploy-approval';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { scrollToFragment } from './scroll-to-fragment';

/** The single inbox of everything waiting on the Commander, resolvable in place. */
@Component({
  selector: 'orb-approvals-page',
  imports: [
    EmptyState,
    Term,
    RouterLink,
    Icon,
    Backbrief,
    LoadError,
    Skeleton,
    DeployApproval,
    Acknowledge,
    UrlPipe,
  ],
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1>Needs you</h1>
          <p class="page-header__lede">
            <orb-term key="backbrief">Backbriefs</orb-term> to decide, and anything blocked or
            failed. Everything else proceeds without you.
          </p>
        </div>
      </header>

      @if (needsYou.inbox.error(); as err) {
        <orb-load-error [error]="err" (retry)="needsYou.reload()" />
      } @else if (!needsYou.inbox.hasValue()) {
        <orb-skeleton variant="block" [lines]="2" />
      } @else if (needsYou.count() === 0) {
        <orb-empty-state icon="stamp" title="Nothing waiting on you">
          When a unit sends a plan for approval, a bot escalates something it may not decide alone,
          or work gets blocked, it appears here.
        </orb-empty-state>
      } @else {
        @if (needsYou.backbriefs().length) {
          <section aria-labelledby="bb-h">
            <h2 id="bb-h" class="panel__title">
              Backbriefs awaiting approval ({{ needsYou.backbriefs().length }})
            </h2>
            <ul class="list-reset stack">
              @for (bb of needsYou.backbriefs(); track bb.id) {
                <li class="panel"><orb-backbrief [backbrief]="bb" /></li>
              }
            </ul>
          </section>
        }
        @if (needsYou.items().length) {
          <section aria-labelledby="other-h">
            <h2 id="other-h" class="panel__title">Deploys, escalations, blocks and failures</h2>
            <ul class="list-reset panel items">
              @for (a of needsYou.items(); track a.entityId + a.kind) {
                <li>
                  <orb-icon
                    class="sm"
                    [name]="
                      a.kind === 'failed-task'
                        ? 'triangle-alert'
                        : a.kind === 'budget'
                          ? 'coins'
                          : a.kind === 'escalation'
                            ? 'arrow-right'
                            : a.kind === 'dispute'
                              ? 'users'
                              : 'octagon-pause'
                    "
                  />
                  <span class="meta">{{ a.unitName }}</span>
                  <a [routerLink]="a.link | url">{{ a.label }}</a>
                  @if (a.action === 'approve-deploy') {
                    <orb-deploy-approval
                      class="inline"
                      [taskId]="a.entityId"
                      [unitId]="a.unitId"
                      [label]="a.label"
                    />
                  } @else if (a.action === 'acknowledge' && a.chainId) {
                    <orb-acknowledge
                      class="inline"
                      [chainId]="a.chainId"
                      [unitId]="a.unitId"
                      [label]="a.label"
                    />
                  }
                </li>
              }
            </ul>
          </section>
        }
      }
    </div>
  `,
  styles: `
    .stack {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .items li {
      display: grid;
      grid-template-columns: max-content max-content minmax(0, 1fr);
      align-items: center;
      gap: var(--space-3);
      min-height: var(--row-height);
      border-top: var(--border-width) solid var(--color-border);
      &:first-child {
        border-top: 0;
      }
    }
    orb-icon {
      color: var(--tone-warning);
    }
    .inline {
      grid-column: 1 / -1;
      padding-bottom: var(--space-3);
    }
  `,
})
export class ApprovalsPage {
  protected readonly needsYou = inject(NeedsYou);
  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Approvals' }]);
    scrollToFragment();
  }
}
