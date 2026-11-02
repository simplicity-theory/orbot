import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { CommitDetailView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { PageTitle } from '../../core/title';
import { FileDiffs } from '../../ui/file-diffs';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { CommitOriginLine } from './commit-origin';

/**
 * One commit: its message, who made it (from the record), and what it changed. Reached from a
 * repository's history (`/supply/repositories/:repoId/commits/:sha`) or by id alone from a
 * bot's notes (`/commits/:sha`, which moves to the full address once it is found).
 */
@Component({
  selector: 'orb-commit-page',
  imports: [CommitOriginLine, FileDiffs, LoadError, RelativeTimePipe, RouterLink, Skeleton],
  template: `
    <div class="page page--detail">
      @if (view.error(); as err) {
        <orb-load-error [error]="err" (retry)="view.reload()" />
      } @else if (view.value(); as v) {
        <header class="page-header">
          <div>
            <p class="page-header__eyebrow">
              Commit ·
              <a [routerLink]="['/supply/repositories', v.repository.id]">{{
                v.repository.name
              }}</a>
            </p>
            <h1>{{ v.commit.subject }}</h1>
            <p class="page-header__lede">
              <orb-commit-origin [origin]="v.commit.origin" />
            </p>
          </div>
        </header>
        <section class="panel" aria-label="Commit details">
          <dl class="dl">
            <dt>Commit</dt>
            <dd class="mono">{{ v.commit.sha }}</dd>
            <dt>When</dt>
            <dd>
              <time [attr.datetime]="v.commit.date" [attr.title]="full(v.commit.date)">{{
                v.commit.date | relativeTime
              }}</time>
              by {{ v.commit.author }}
            </dd>
            @if (v.commit.parents.length) {
              <dt>{{ v.commit.parents.length > 1 ? 'Parents' : 'Parent' }}</dt>
              <dd>
                @for (p of v.commit.parents; track p; let first = $first) {
                  <a
                    class="mono"
                    [routerLink]="['/supply/repositories', v.repository.id, 'commits', p]"
                    >{{ p.slice(0, 10) }}</a
                  >
                  @if (first && v.commit.parents.length > 1) {
                    <span class="meta">(changes shown against this one)</span>
                  }
                  {{ ' ' }}
                }
              </dd>
            }
            @if (v.commit.refs.length) {
              <dt>Tip of</dt>
              <dd>
                @for (r of v.commit.refs; track r) {
                  <a
                    class="chip mono"
                    [routerLink]="['/supply/repositories', v.repository.id]"
                    [queryParams]="{ ref: r }"
                    >{{ r }}</a
                  >
                }
              </dd>
            }
          </dl>
          @if (v.body) {
            <pre class="prose message">{{ v.body }}</pre>
          }
        </section>
        <section class="panel" aria-labelledby="changes-h">
          <h2 id="changes-h" class="panel__title">Changes</h2>
          <orb-file-diffs
            [files]="v.files"
            [truncated]="v.truncated"
            empty="This commit changes no files."
          />
        </section>
      } @else {
        <orb-skeleton [lines]="8" />
      }
    </div>
  `,
  styles: `
    .page-header__eyebrow a,
    dd a {
      text-decoration: underline;
    }
    .message {
      margin-top: var(--space-3);
      white-space: pre-wrap;
    }
    dd .chip + .chip {
      margin-left: var(--space-1);
    }
  `,
})
export class CommitPage {
  /** Absent on `/commits/:sha`: the API finds the repository. */
  readonly repoId = input<string>();
  readonly sha = input.required<string>();
  protected readonly view = httpResource<CommitDetailView>(() =>
    this.repoId() ? apiUrl.commit(this.repoId()!, this.sha()) : apiUrl.findCommit(this.sha()),
  );
  protected readonly full = fullDate;
  private readonly short = computed(() => this.sha().slice(0, 10));

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    const router = inject(Router);
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      // Found by id alone: move to its full address, so the link can be shared.
      if (!this.repoId()) {
        void router.navigate(['/supply/repositories', v.repository.id, 'commits', v.commit.sha], {
          replaceUrl: true,
        });
      }
      crumbs.set([
        ORBAT_CRUMB,
        { label: 'Supply Depot', term: 'supply-depot', link: '/supply' },
        { label: v.repository.name, link: `/supply/repositories/${v.repository.id}` },
        { label: this.short() },
      ]);
      title.set(`${v.commit.subject} · ${v.repository.name}`);
    });
  }
}
