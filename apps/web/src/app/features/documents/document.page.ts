import { Can } from '../../ui/can';
import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { marked } from 'marked';
import type { DocumentView, UnitDetailView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { PageTitle } from '../../core/title';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

const KIND_TERM: Record<string, string> = {
  'field-manual': 'field-manual',
  handover: 'handover',
  'standing-orders': 'standing-orders',
  'after-action': 'after-action',
};

/** One unit document: rendered, editable (a new version each time), with its history a click away. */
@Component({
  selector: 'orb-document-page',
  imports: [Can, FormsModule, RouterLink, Icon, LoadError, Skeleton, Term, RelativeTimePipe],
  template: `
    @if (doc.error(); as err) {
      <div class="page"><orb-load-error [error]="err" (retry)="doc.reload()" /></div>
    } @else if (doc.hasValue()) {
      @let d = doc.value();
      <div class="page page--detail">
        <header class="page-header">
          <div>
            <p class="page-header__eyebrow">
              @if (term(); as t) {
                <orb-term [key]="t">{{ d.kind }}</orb-term>
              } @else {
                {{ d.kind }}
              }
              · version {{ d.version }}
            </p>
            <h1>{{ d.title }}</h1>
            <p class="page-header__lede">
              Last changed
              <time [attr.datetime]="d.updatedAt" [attr.title]="full(d.updatedAt)">{{
                d.updatedAt | relativeTime
              }}</time>
              by <span class="mono">{{ d.updatedBy }}</span>
            </p>
          </div>
          <div class="header-actions">
            <a class="btn" [routerLink]="['/archive', d.id]"><orb-icon name="history" /> History</a>
            @if (d.kind === 'field-manual') {
              <a
                class="btn btn--primary"
                [routerLink]="['/units', unitId()]"
                [queryParams]="{ section: 'field-manual' }"
                >Edit entries</a
              >
            } @else if (!editing()) {
              <button
                *orbCan="unitId()"
                type="button"
                class="btn btn--primary"
                (click)="startEdit(d)"
              >
                Edit
              </button>
            }
          </div>
        </header>

        @if (editing()) {
          <form class="form panel" (ngSubmit)="save(d)">
            <label for="md">Markdown</label>
            <textarea
              id="md"
              name="md"
              class="input editor"
              rows="18"
              [(ngModel)]="markdown"
            ></textarea>
            <label for="why">Why the change?</label>
            <input id="why" name="why" class="input" [(ngModel)]="reason" required />
            <p class="hint">
              Saving creates version {{ d.version + 1 }}; version {{ d.version }} stays in the
              archive.
            </p>
            <div class="actions">
              <button type="button" class="btn btn--ghost" (click)="editing.set(false)">
                Cancel
              </button>
              <button type="submit" class="btn btn--primary" [disabled]="busy() || !reason.trim()">
                Save new version
              </button>
            </div>
          </form>
        } @else {
          <article class="panel markdown" [innerHTML]="html()"></article>
        }
      </div>
    } @else {
      <div class="page page--detail" aria-busy="true"><orb-skeleton [lines]="10" /></div>
    }
  `,
  styles: `
    .header-actions {
      display: flex;
      gap: var(--space-2);
    }
    .editor {
      font-family: var(--font-mono);
      font-size: var(--font-size-sm);
    }
    .markdown {
      line-height: var(--line-height);
      ::ng-deep {
        h1 {
          font-size: var(--font-size-xl);
          margin-bottom: var(--space-4);
        }
        h2 {
          font-size: var(--font-size-lg);
          margin: var(--space-6) 0 var(--space-2);
        }
        p,
        ul,
        ol,
        blockquote {
          margin: 0 0 var(--space-3);
        }
        ul,
        ol {
          padding-left: var(--space-5);
        }
        blockquote {
          padding-left: var(--space-3);
          border-left: calc(var(--border-width) * 3) solid var(--color-border-strong);
          color: var(--color-text-muted);
        }
        code {
          padding: 0 var(--space-1);
          border-radius: var(--radius-sm);
          background: var(--color-surface-3);
        }
        em {
          color: var(--color-text-muted);
        }
      }
    }
  `,
})
export class DocumentPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly unitId = input.required<string>();
  readonly documentId = input.required<string>();
  protected readonly doc = httpResource<DocumentView>(() => apiUrl.document(this.documentId()));
  private readonly unit = httpResource<UnitDetailView>(() => apiUrl.unit(this.unitId()));
  protected readonly html = computed(() =>
    marked.parse(this.doc.value()?.markdown ?? '', { async: false }),
  );
  protected readonly term = computed(() => KIND_TERM[this.doc.value()?.kind ?? ''] ?? null);
  protected readonly editing = signal(false);
  protected readonly busy = signal(false);
  protected readonly full = fullDate;
  protected markdown = '';
  protected reason = '';

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const d = this.doc.value();
      if (!d) return;
      const unitName = this.unit.value()?.unit.name ?? 'Unit';
      crumbs.set([
        ORBAT_CRUMB,
        { label: unitName, link: `/units/${this.unitId()}` },
        { label: d.title },
      ]);
      title.set(d.title);
    });
    reloadOnLive(
      (n) => n.type === 'version' && n.version.entityId === this.documentId(),
      () => this.doc.reload(),
    );
  }

  protected startEdit(d: DocumentView): void {
    this.markdown = d.markdown;
    this.reason = '';
    this.editing.set(true);
  }

  protected async save(d: DocumentView): Promise<void> {
    this.busy.set(true);
    const reason = this.reason.trim();
    try {
      const saved = await this.api.reviseDocument(d.id, {
        markdown: this.markdown,
        reason,
        expectedVersion: d.version,
      });
      this.editing.set(false);
      this.doc.reload();
      this.toasts.show({
        tone: 'success',
        message: `Saved as version ${saved.version}.`,
        detail: `Version ${d.version} is in the archive.`,
        undo: async () => {
          const back = await this.api.reviseDocument(d.id, {
            markdown: d.markdown,
            reason: `Undo: ${reason}`,
            expectedVersion: saved.version,
          });
          this.toasts.show({
            tone: 'info',
            message: `Restored the earlier text as version ${back.version}.`,
          });
          this.doc.reload();
        },
      });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
