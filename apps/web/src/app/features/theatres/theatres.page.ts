import { Can } from '../../ui/can';
import { Dialog } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { TheatreSummary } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { openDialog } from '../../ui/dialog';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { NewTheatreDialog } from './new-theatre.dialog';

/** The theatres: one per software project, each with its repository, its site and its operations. */
@Component({
  selector: 'orb-theatres-page',
  imports: [Can, RouterLink, EmptyState, Icon, LoadError, Skeleton, Term],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1><orb-term key="theatre">Theatres</orb-term></h1>
          <p class="page-header__lede">
            One per project: the repository the work lands in, where it deploys, and the
            <orb-term key="operation">operations</orb-term> run in it.
          </p>
        </div>
        <div *orbCan="null" class="buttons">
          <button type="button" class="btn btn--primary" (click)="newTheatre()">New theatre</button>
        </div>
      </header>
      @if (theatres.error(); as err) {
        <orb-load-error [error]="err" (retry)="theatres.reload()" />
      } @else if (theatres.hasValue()) {
        <ul class="list-reset board">
          @for (t of theatres.value(); track t.theatre.id) {
            <li class="panel theatre" [attr.aria-labelledby]="'th-' + t.theatre.id">
              <header>
                <h2 [id]="'th-' + t.theatre.id">
                  <a [routerLink]="['/theatres', t.theatre.id]">Theatre {{ t.theatre.name }}</a>
                </h2>
                @if (t.theatre.status === 'closed') {
                  <span class="chip">closed</span>
                }
                @if (t.needsYou) {
                  <a class="needs" [routerLink]="['/theatres', t.theatre.id]"
                    >{{ t.needsYou }} need you</a
                  >
                }
              </header>
              @if (t.theatre.description) {
                <p class="meta">{{ t.theatre.description }}</p>
              }
              @if (t.site?.published) {
                <p>
                  <a class="btn btn--primary" [href]="t.site!.url" target="_blank" rel="noopener">
                    <orb-icon name="link" /> Open the app
                  </a>
                </p>
              }
              <p class="where">
                <orb-icon class="sm" name="git-branch" />
                {{ t.repository?.name ?? 'No repository yet' }}
                @if (t.site; as s) {
                  · <orb-icon class="sm" name="link" />
                  @if (s.url) {
                    <a [href]="s.url" target="_blank" rel="noopener">{{ s.name }}</a>
                  } @else {
                    {{ s.name }}
                  }
                }
              </p>
              <ul class="list-reset ops">
                @for (o of t.operations; track o.id) {
                  <li>
                    <a [routerLink]="['/operations', o.id]">Operation {{ o.name }}</a>
                    <span class="meta">{{ o.phase }}</span>
                    @if (o.needsYou) {
                      <span class="needs">{{ o.needsYou }} need you</span>
                    }
                  </li>
                } @empty {
                  <li class="meta">No operation yet: state your intent on the theatre's page.</li>
                }
              </ul>
            </li>
          } @empty {
            <orb-empty-state icon="crosshair" title="No theatre yet">
              A theatre is a project: open one for a codebase, give it its repository and where it
              deploys, then state your <orb-term key="intent">intent</orb-term> inside it.
              <div actions>
                <button
                  *orbCan="null"
                  type="button"
                  class="btn btn--primary"
                  (click)="newTheatre()"
                >
                  New theatre
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
    }
    .board {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .theatre {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
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
    .where {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1);
      margin: 0;
    }
    .ops li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3);
      min-height: var(--row-height-dense);
      border-top: var(--border-width) solid var(--color-border);
    }
    .needs {
      color: var(--tone-warning);
      font-weight: var(--font-weight-semibold);
    }
  `,
})
export class TheatresPage {
  protected readonly theatres = httpResource<TheatreSummary[]>(() => apiUrl.theatres());
  private readonly dialog = inject(Dialog);

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Theatres', term: 'theatre' }]);
    reloadOnLive(
      (n) =>
        n.type === 'version' && ['theatre', 'operation', 'supply'].includes(n.version.entityType),
      () => this.theatres.reload(),
    );
  }

  protected newTheatre(): void {
    openDialog(this.dialog, NewTheatreDialog, null, 'New theatre');
  }
}
