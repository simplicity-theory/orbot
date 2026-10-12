import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Breadcrumbs as BreadcrumbsService } from '../core/breadcrumbs';
import { Icon } from '../ui/icon';
import { Term } from '../ui/term';

/** Mirrors the chain of command. Every object is one click from its parent. */
@Component({
  selector: 'orb-breadcrumbs',
  imports: [RouterLink, Icon, Term],
  template: `
    <nav aria-label="Breadcrumb">
      <ol class="list-reset">
        @for (c of crumbs.trail(); track $index; let last = $last) {
          <li>
            @if (c.link && !last) {
              <a [routerLink]="c.link">{{ c.label }}</a>
              <orb-icon class="sm sep" name="chevron-right" />
            } @else {
              <span aria-current="page">
                @if (c.term) {
                  <orb-term [key]="c.term">{{ c.label }}</orb-term>
                } @else {
                  {{ c.label }}
                }
              </span>
            }
          </li>
        }
      </ol>
    </nav>
  `,
  styles: `
    ol {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1);
      font-size: var(--font-size-sm);
    }
    li {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      min-width: 0;
    }
    a {
      color: var(--color-text-muted);
    }
    [aria-current='page'] {
      color: var(--color-text);
      font-weight: var(--font-weight-medium);
    }
    .sep {
      color: var(--color-text-subtle);
    }
  `,
})
export class Breadcrumbs {
  protected readonly crumbs = inject(BreadcrumbsService);
}
