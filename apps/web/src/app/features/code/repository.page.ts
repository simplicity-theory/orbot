import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { RepositoryHistoryView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { PageTitle } from '../../core/title';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { CommitOriginLine } from './commit-origin';

const GROUP: Record<RepositoryHistoryView['refs'][number]['kind'], string> = {
  default: 'Default branch',
  operation: 'Operations (integration branches)',
  task: 'Tasks',
  other: 'Other branches',
};

/** A repository's history, branch by branch, each commit tied to the bot and task that made it. */
@Component({
  selector: 'orb-repository-page',
  imports: [CommitOriginLine, LoadError, RelativeTimePipe, RouterLink, Skeleton],
  template: `
    <div class="page">
      @if (view.error(); as err) {
        <orb-load-error [error]="err" (retry)="view.reload()" />
      } @else if (view.value(); as v) {
        <header class="page-header">
          <div>
            <p class="page-header__eyebrow">Repository</p>
            <h1>{{ v.repository.name }}</h1>
            <p class="page-header__lede">
              Every commit on a branch, newest first. Bots work on their own task branches; HQ
              integrates them on the operation's branch.
            </p>
          </div>
        </header>
        <div class="branch">
          <label for="ref">Branch</label>
          <select
            id="ref"
            class="input mono"
            [value]="v.ref"
            (change)="pick($any($event.target).value)"
          >
            @for (g of groups(); track g.kind) {
              <optgroup [label]="g.label">
                @for (r of g.refs; track r.name) {
                  <option [value]="r.name" [selected]="r.name === v.ref">{{ r.name }}</option>
                }
              </optgroup>
            }
          </select>
        </div>
        <section class="panel" aria-labelledby="commits-h">
          <h2 id="commits-h" class="panel__title">
            Commits on <span class="mono">{{ v.ref }}</span>
            <span class="meta"
              >{{ v.commits.length }}{{ v.commits.length === 200 ? '+' : '' }}</span
            >
          </h2>
          <ol class="list-reset commits">
            @for (c of v.commits; track c.sha) {
              <li>
                <a
                  class="subject"
                  [routerLink]="['/supply/repositories', v.repository.id, 'commits', c.sha]"
                  >{{ c.subject }}</a
                >
                <span class="meta line">
                  <span class="mono">{{ c.sha.slice(0, 10) }}</span> ·
                  <time [attr.datetime]="c.date" [attr.title]="full(c.date)">{{
                    c.date | relativeTime
                  }}</time>
                  · <orb-commit-origin [origin]="c.origin" [compact]="true" />
                  @for (r of c.refs; track r) {
                    <span class="chip mono">{{ r }}</span>
                  }
                </span>
              </li>
            } @empty {
              <li class="meta">No commits.</li>
            }
          </ol>
        </section>
      } @else {
        <orb-skeleton [lines]="8" />
      }
    </div>
  `,
  styles: `
    .branch {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-4);
      select {
        flex: 0 1 auto;
        min-width: 0;
        max-width: 100%;
      }
    }
    .commits li {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      padding: var(--space-2) 0;
      border-bottom: var(--border-width) solid var(--color-border);
    }
    .subject {
      font-weight: var(--font-weight-medium);
      overflow-wrap: anywhere;
    }
    .line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1);
    }
  `,
})
export class RepositoryPage {
  readonly repoId = input.required<string>();
  /** `?ref=` — the branch shown. */
  readonly ref = input<string>();
  protected readonly view = httpResource<RepositoryHistoryView>(() =>
    apiUrl.repositoryHistory(this.repoId(), this.ref()),
  );
  protected readonly full = fullDate;
  private readonly router = inject(Router);

  protected readonly groups = computed(() => {
    const refs = this.view.value()?.refs ?? [];
    return (['default', 'operation', 'task', 'other'] as const)
      .map((kind) => ({ kind, label: GROUP[kind], refs: refs.filter((r) => r.kind === kind) }))
      .filter((g) => g.refs.length);
  });

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      crumbs.set([
        ORBAT_CRUMB,
        { label: 'Supply Depot', term: 'supply-depot', link: '/supply' },
        { label: v.repository.name },
      ]);
      title.set(`${v.repository.name} · history`);
    });
    // New commits arrive as artifact events on the record.
    reloadOnLive(
      (n) =>
        n.type === 'event' &&
        ['artifact', 'integration', 'handoff', 'deployment'].includes(n.event.kind),
      () => this.view.reload(),
    );
  }

  protected pick(ref: string): void {
    const v = this.view.value();
    void this.router.navigate([], {
      queryParams: { ref: ref === v?.repository.defaultBranch ? null : ref },
    });
  }
}
