import { HttpParams, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { SearchHit, SearchScope } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { EmptyState } from '../../ui/empty-state';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { TYPE_LABELS } from './entity-title';

const FILTERS = [
  'document',
  'fm-entry',
  'backbrief',
  'task',
  'bot',
  'unit',
  'mission',
  'supply',
  'diary.entry',
  'sitrep',
  'bot.step',
  'artifact',
  'chat.message',
  'orders.log',
];

@Component({
  selector: 'orb-archive-page',
  imports: [FormsModule, RouterLink, EmptyState, LoadError, Skeleton, RelativeTimePipe, Term],
  templateUrl: './archive.page.html',
  styleUrl: './archive.page.scss',
})
export class ArchivePage implements OnInit {
  private readonly router = inject(Router);
  /** Bound from query params so every search is deep-linkable (absent params arrive as undefined). */
  readonly q = input('', { transform: (v: string | undefined) => v ?? '' });
  readonly scope = input<SearchScope, SearchScope | undefined>('active', {
    transform: (v) => v ?? 'active',
  });
  readonly types = input('', { transform: (v: string | undefined) => v ?? '' });

  protected draft = '';
  protected readonly filters = FILTERS;
  protected readonly labels = TYPE_LABELS;
  protected readonly full = fullDate;
  protected readonly selectedTypes = computed(() => (this.types() ? this.types().split(',') : []));

  protected readonly results = httpResource<SearchHit[]>(() => {
    const q = this.q().trim();
    if (!q) return undefined;
    let params = new HttpParams().set('q', q).set('scope', this.scope() || 'active');
    if (this.types()) params = params.set('types', this.types());
    return { url: apiUrl.search(), params };
  });

  protected readonly groups = computed(() => {
    const hits = this.results.value() ?? [];
    const by = new Map<string, SearchHit[]>();
    for (const h of hits) by.set(h.type, [...(by.get(h.type) ?? []), h]);
    return [...by.entries()].map(([type, items]) => ({
      type,
      label: TYPE_LABELS[type] ?? type,
      items,
    }));
  });

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Archive', term: 'archive' }]);
  }

  ngOnInit(): void {
    this.draft = this.q();
  }

  protected search(patch: { q?: string; scope?: SearchScope; types?: string[] } = {}): void {
    const types = patch.types ?? this.selectedTypes();
    void this.router.navigate([], {
      queryParams: {
        q: (patch.q ?? this.draft).trim() || null,
        scope: (patch.scope ?? this.scope()) === 'active' ? null : (patch.scope ?? this.scope()),
        types: types.length ? types.join(',') : null,
      },
    });
  }

  protected toggleType(t: string): void {
    const cur = this.selectedTypes();
    this.search({ types: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t] });
  }

  /** Splits a ⟦highlighted⟧ snippet into text parts, so nothing is ever rendered as HTML. */
  protected highlight(snippet: string): { text: string; hit: boolean }[] {
    return snippet
      .split(/(⟦[^⟧]*⟧)/)
      .filter(Boolean)
      .map((p) =>
        p.startsWith('⟦') ? { text: p.slice(1, -1), hit: true } : { text: p, hit: false },
      );
  }

  protected link(h: SearchHit): { path: string[]; query: Record<string, string> } | null {
    if (h.source === 'version' && h.entityId)
      return { path: ['/archive', h.entityId], query: { v: String(h.version) } };
    if (h.unitId && h.taskId && h.botId)
      return { path: ['/units', h.unitId, 'bots', h.botId, 'tasks', h.taskId], query: {} };
    if (h.unitId && h.taskId) return { path: ['/units', h.unitId, 'tasks', h.taskId], query: {} };
    return null;
  }
}
