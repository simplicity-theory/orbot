import { Can } from '../../ui/can';
import { httpResource } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { marked } from 'marked';
import type { DailyBriefView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

/** HQ's daily brief to the Commander: today's in full, and every earlier one. */
@Component({
  selector: 'orb-brief-page',
  imports: [Can, RouterLink, EmptyState, Icon, LoadError, RelativeTimePipe, Skeleton, Term],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1><orb-term key="daily-brief">Daily brief</orb-term></h1>
          <p class="page-header__lede">
            Once a day HQ tells you what happened, what is under way, what it cost and what needs
            you.
            @if (brief.value()?.nextAt; as next) {
              Next one
              <time [attr.datetime]="next" [attr.title]="full(next)">{{ next | relativeTime }}</time
              >.
            } @else if (brief.hasValue()) {
              The daily brief is switched off in <a routerLink="/settings">Settings</a>.
            }
          </p>
        </div>
        <button
          *orbCan="null"
          type="button"
          class="btn btn--primary"
          [disabled]="busy()"
          (click)="writeNow()"
        >
          Write today's brief now
        </button>
      </header>
      @if (brief.error(); as err) {
        <orb-load-error [error]="err" (retry)="brief.reload()" />
      } @else if (brief.value(); as v) {
        @if (v.latest; as b) {
          <article class="panel markdown" aria-labelledby="brief-h">
            <h2 id="brief-h" class="visually-hidden">{{ b.title }}</h2>
            <div [innerHTML]="md(b.markdown)"></div>
            <p class="meta">
              <a [routerLink]="['/archive', b.id]"
                ><orb-icon class="sm" name="history" /> Versions of this brief</a
              >
            </p>
          </article>
        } @else {
          <orb-empty-state icon="sun" title="No brief yet">
            HQ writes the first one at the time set in Settings, or now if you ask.
          </orb-empty-state>
        }
        @if (v.earlier.length) {
          <section class="panel" aria-labelledby="earlier-h">
            <h2 id="earlier-h" class="panel__title">Earlier briefs</h2>
            <ul class="list-reset rows">
              @for (e of v.earlier; track e.id) {
                <li>
                  <a [routerLink]="['/archive', e.id]">{{ e.title }}</a>
                </li>
              }
            </ul>
          </section>
        }
      } @else {
        <orb-skeleton variant="block" [lines]="6" />
      }
    </div>
  `,
  styles: `
    .markdown ::ng-deep {
      h2 {
        font-size: var(--font-size-xl);
        margin-bottom: var(--space-2);
      }
      h3 {
        font-size: var(--font-size-lg);
        margin: var(--space-5) 0 var(--space-2);
      }
      ul {
        padding-left: var(--space-5);
      }
      table {
        border-collapse: collapse;
        width: 100%;
      }
      th,
      td {
        text-align: left;
        padding: var(--space-1) var(--space-2);
        border-bottom: var(--border-width) solid var(--color-border);
      }
    }
  `,
})
export class BriefPage {
  protected readonly brief = httpResource<DailyBriefView>(() => apiUrl.dailyBrief());
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly busy = signal(false);
  protected readonly full = fullDate;

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Daily brief', term: 'daily-brief' }]);
    reloadOnLive(
      (n) =>
        n.type === 'version' &&
        n.version.entityType === 'document' &&
        (n.version.body as { kind?: string }).kind === 'daily-brief',
      () => this.brief.reload(),
    );
  }

  /** The brief's own headings sit under the page's h1. */
  protected md(markdown: string): string {
    return marked.parse(markdown.replace(/^(#{1,4}) /gm, '#$1 '), { async: false });
  }

  protected async writeNow(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.writeDailyBrief();
      this.brief.reload();
      this.toasts.show({ tone: 'success', message: "Today's brief is written." });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
