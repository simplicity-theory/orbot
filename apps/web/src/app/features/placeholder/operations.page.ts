import { httpResource } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { OperationView } from '@orbot/shared';
import { API } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { EmptyState } from '../../ui/empty-state';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';

@Component({
  selector: 'orb-operations-page',
  imports: [EmptyState, LoadError, Skeleton, Term, RouterLink],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1><orb-term key="operation">Operations</orb-term></h1>
          <p class="page-header__lede">
            Large pieces of work owned by HQ, split into missions across units.
          </p>
        </div>
      </header>
      @if (ops.error(); as err) {
        <orb-load-error [error]="err" (retry)="ops.reload()" />
      } @else if (ops.hasValue()) {
        @for (op of ops.value(); track op.id) {
          <article class="panel">
            <p class="page-header__eyebrow">Phase: {{ op.phase }}</p>
            <h2>{{ op.name }}</h2>
            <p class="meta"><orb-term key="intent">Intent</orb-term>: {{ op.intent }}</p>
            <p class="meta"><a [routerLink]="['/archive', op.id]">History</a></p>
          </article>
        } @empty {
          <orb-empty-state icon="flag" title="No operations yet">
            State your <orb-term key="intent">intent</orb-term> to launch one: what you want
            achieved and why. HQ will split it into missions for the units involved.
          </orb-empty-state>
        }
      } @else {
        <orb-skeleton variant="block" [lines]="2" />
      }
    </div>
  `,
  styles: `
    article {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
  `,
})
export class OperationsPage {
  protected readonly ops = httpResource<OperationView[]>(() => `${API}/operations`);
  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Operations' }]);
  }
}
