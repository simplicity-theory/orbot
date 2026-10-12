import { HttpParams, httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { VersionDiff, VersionWithStatus } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { PageTitle } from '../../core/title';
import { DiffView } from '../../ui/diff-view';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { entityTitle } from './entity-title';

type Tab = 'content' | 'changes';

/**
 * Every version of one thing in the record: timeline, content, side-by-side diff,
 * and "as it stood on" any past date. State lives in the URL so any view is linkable.
 */
@Component({
  selector: 'orb-history-page',
  imports: [RouterLink, DiffView, Icon, LoadError, Skeleton, RelativeTimePipe],
  templateUrl: './history.page.html',
  styleUrl: './history.page.scss',
})
export class HistoryPage {
  private readonly router = inject(Router);
  readonly entityId = input.required<string>();
  /** Selected version (query param). Defaults to the current one. */
  readonly v = input<string>();
  /** Version to compare against (query param). Defaults to the previous one. */
  readonly against = input<string>();
  readonly tab = input<Tab>();

  protected readonly full = fullDate;
  protected readonly asOfInput = signal('');
  protected readonly asOfMessage = signal<string | null>(null);

  protected readonly history = httpResource<VersionWithStatus[]>(() =>
    apiUrl.history(this.entityId()),
  );

  protected readonly current = computed(() => this.history.value()?.at(-1) ?? null);
  protected readonly selected = computed(() => {
    const h = this.history.value();
    if (!h?.length) return null;
    const n = Number(this.v());
    return h.find((x) => x.version === n) ?? h.at(-1)!;
  });
  protected readonly compareTo = computed(() => {
    const sel = this.selected();
    if (!sel) return null;
    const n = Number(this.against());
    if (n && n !== sel.version) return n;
    return sel.version > 1 ? sel.version - 1 : null;
  });
  protected readonly activeTab = computed<Tab>(() =>
    this.tab() === 'changes' && this.compareTo() ? 'changes' : 'content',
  );
  protected readonly title = computed(() => {
    const c = this.current();
    return c ? entityTitle(c.entityType, c.body) : '';
  });

  protected readonly diff = httpResource<VersionDiff>(() => {
    const sel = this.selected();
    const other = this.compareTo();
    if (!sel || !other || this.activeTab() !== 'changes') return undefined;
    const [from, to] = other < sel.version ? [other, sel.version] : [sel.version, other];
    return {
      url: apiUrl.diff(this.entityId()),
      params: new HttpParams().set('from', from).set('to', to),
    };
  });

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const pageTitle = inject(PageTitle);
    effect(() => {
      const t = this.title();
      if (!t) return;
      crumbs.set([
        ORBAT_CRUMB,
        { label: 'Archive', link: '/archive', term: 'archive' },
        { label: t },
      ]);
      pageTitle.set(`History: ${t}`);
    });
    reloadOnLive(
      (n) => n.type === 'version' && n.version.entityId === this.entityId(),
      () => this.history.reload(),
    );
  }

  protected bodyText(v: VersionWithStatus): string {
    const b = v.body as Record<string, unknown>;
    if (v.entityType === 'document' && typeof b['markdown'] === 'string') return b['markdown'];
    return JSON.stringify(v.body, null, 2);
  }

  protected select(version: number, extra: Record<string, string | null> = {}): void {
    void this.router.navigate([], {
      queryParams: { v: version, ...extra },
      queryParamsHandling: 'merge',
    });
  }

  protected showTab(tab: Tab): void {
    void this.router.navigate([], {
      queryParams: { tab: tab === 'content' ? null : tab },
      queryParamsHandling: 'merge',
    });
  }

  /** Arrow keys move between tabs (WAI-ARIA tabs pattern). */
  protected onTabKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: Tab = this.activeTab() === 'content' && this.compareTo() ? 'changes' : 'content';
    this.showTab(next);
    queueMicrotask(() => document.getElementById(`tab-${next}`)?.focus());
  }

  protected compareWith(version: string): void {
    void this.router.navigate([], {
      queryParams: { against: version || null, tab: 'changes' },
      queryParamsHandling: 'merge',
    });
  }

  /** Find the version that was current at the chosen moment. */
  protected viewAsOf(): void {
    const raw = this.asOfInput();
    if (!raw) return;
    const at = new Date(raw);
    const h = this.history.value() ?? [];
    const found = [...h].reverse().find((x) => new Date(x.createdAt) <= at);
    if (!found) {
      this.asOfMessage.set(
        `It did not exist yet on ${fullDate(at.toISOString())}. The first version was written ${fullDate(h[0]!.createdAt)}.`,
      );
      return;
    }
    this.asOfMessage.set(
      `Showing version ${found.version}, as it stood on ${fullDate(at.toISOString())}.`,
    );
    this.select(found.version, { tab: null, against: null });
  }
}
