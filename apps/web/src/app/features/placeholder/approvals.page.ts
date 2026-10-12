import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { NeedsYou } from '../../core/needs-you';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { Term } from '../../ui/term';

/** The single inbox of everything waiting on the Commander. */
@Component({
  selector: 'orb-approvals-page',
  imports: [EmptyState, Term, RouterLink, Icon],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Needs you</h1>
          <p class="page-header__lede">
            <orb-term key="backbrief">Backbriefs</orb-term> and
            <orb-term key="escalation">escalations</orb-term> waiting on your decision, plus
            anything blocked or failed.
          </p>
        </div>
      </header>
      @if (needsYou.items().length) {
        <ul class="list-reset panel">
          @for (a of needsYou.items(); track a.entityId + a.kind) {
            <li>
              <orb-icon
                class="sm"
                [name]="
                  a.kind === 'failed-task'
                    ? 'triangle-alert'
                    : a.kind === 'blocked-bot'
                      ? 'octagon-pause'
                      : 'stamp'
                "
              />
              <span class="meta">{{ a.unit }}</span>
              <a [routerLink]="a.link">{{ a.label }}</a>
            </li>
          }
        </ul>
      } @else {
        <orb-empty-state icon="stamp" title="Nothing waiting on you">
          When a unit sends a plan for approval, a bot escalates something it may not decide alone,
          or work gets blocked, it appears here.
        </orb-empty-state>
      }
    </div>
  `,
  styles: `
    li {
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
  `,
})
export class ApprovalsPage {
  protected readonly needsYou = inject(NeedsYou);
  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Approvals' }]);
  }
}
