import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { DocumentView, FmEntryView, SourceRef, UnitDetailView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Icon } from '../../ui/icon';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

type Editing = { id: string; title: string; body: string; reason: string } | null;

/** The unit's Field Manual: entries with provenance; add, edit and retire (never delete). */
@Component({
  selector: 'orb-field-manual-tab',
  imports: [FormsModule, RouterLink, Icon, Term],
  template: `
    @let v = view();
    <section class="panel" aria-labelledby="fm-h">
      <h2 id="fm-h" class="panel__title">
        <span
          ><orb-term key="field-manual">Field Manual</orb-term> ·
          {{ v.fieldManual.length }} entries</span
        >
        @if (fieldManualDoc(); as doc) {
          <span class="links">
            <a [routerLink]="['/units', v.unit.id, 'documents', doc.id]"
              ><orb-icon class="sm" name="file-text" /> Whole document</a
            >
            <a [routerLink]="['/archive', doc.id]"
              ><orb-icon class="sm" name="history" /> History</a
            >
          </span>
        }
      </h2>
      <p class="meta">
        Curated by the Overseer from handovers. Every bot is briefed from it.
        @if (v.docsMirror; as m) {
          Kept as Markdown in <span class="mono">{{ m.repository }}</span
          >, branch <span class="mono">{{ m.branch }}</span
          >, <span class="mono">{{ m.path }}/</span>.
          <button type="button" class="btn btn--ghost inline" [disabled]="busy()" (click)="sync()">
            Import edits from the repository
          </button>
        }
      </p>

      <ol class="list-reset entries">
        @for (e of v.fieldManual; track e.id) {
          <li class="entry" [id]="'fm-' + e.id">
            @if (editing()?.id === e.id) {
              <form class="form" (ngSubmit)="saveEdit(e)">
                <label [for]="'t-' + e.id">Title</label>
                <input
                  class="input"
                  [id]="'t-' + e.id"
                  name="title"
                  [(ngModel)]="editing()!.title"
                  required
                />
                <label [for]="'b-' + e.id">Text</label>
                <textarea
                  class="input"
                  [id]="'b-' + e.id"
                  name="body"
                  rows="4"
                  [(ngModel)]="editing()!.body"
                ></textarea>
                <label [for]="'r-' + e.id">Why the change?</label>
                <input
                  class="input"
                  [id]="'r-' + e.id"
                  name="reason"
                  [(ngModel)]="editing()!.reason"
                  required
                />
                <div class="actions">
                  <button type="button" class="btn btn--ghost" (click)="editing.set(null)">
                    Cancel
                  </button>
                  <button
                    type="submit"
                    class="btn btn--primary"
                    [disabled]="busy() || !editing()!.reason.trim()"
                  >
                    Save new version
                  </button>
                </div>
              </form>
            } @else {
              <div class="entry-head">
                <h3>{{ e.title }}</h3>
                @if (e.pinned) {
                  <span class="chip">Pinned</span>
                }
                <span class="meta">v{{ e.version }}</span>
              </div>
              <p class="body">{{ e.body }}</p>
              <p class="sources meta">
                Sources:
                @for (s of e.sources; track $index; let last = $last) {
                  @if (sourceLink(s); as link) {
                    <a [routerLink]="link">{{ s.label }}</a>
                  } @else {
                    <span>{{ s.label }}</span>
                  }
                  @if (!last) {
                    ;
                  }
                }
              </p>
              @if (retiring()?.id === e.id) {
                <form class="form retire" (ngSubmit)="retire(e)">
                  <label [for]="'why-' + e.id"
                    >Why retire it? It moves to the archive; nothing is deleted.</label
                  >
                  <input
                    class="input"
                    [id]="'why-' + e.id"
                    name="why"
                    [(ngModel)]="retiring()!.reason"
                    required
                  />
                  <div class="actions">
                    <button type="button" class="btn btn--ghost" (click)="retiring.set(null)">
                      Cancel
                    </button>
                    <button
                      type="submit"
                      class="btn btn--primary"
                      [disabled]="busy() || !retiring()!.reason.trim()"
                    >
                      Retire entry
                    </button>
                  </div>
                </form>
              }
              <div class="row-actions">
                <button
                  type="button"
                  class="btn btn--ghost"
                  (click)="editing.set({ id: e.id, title: e.title, body: e.body, reason: '' })"
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="btn btn--ghost"
                  [attr.aria-expanded]="retiring()?.id === e.id"
                  (click)="retiring.set({ id: e.id, reason: '' })"
                >
                  Retire…
                </button>
                <a class="btn btn--ghost" [routerLink]="['/archive', e.id]">History</a>
              </div>
            }
          </li>
        } @empty {
          <li class="meta">
            No entries yet. They are promoted from handovers as bots finish tasks, or you can add
            one.
          </li>
        }
      </ol>

      @if (adding()) {
        <form class="form add" (ngSubmit)="saveNew()">
          <h3>New entry</h3>
          <label for="new-title">Title</label>
          <input id="new-title" class="input" name="title" [(ngModel)]="draft.title" required />
          <label for="new-body">Text</label>
          <textarea
            id="new-body"
            class="input"
            name="body"
            rows="3"
            [(ngModel)]="draft.body"
          ></textarea>
          <label class="check"
            ><input type="checkbox" name="pinned" [(ngModel)]="draft.pinned" /> Pin: include in
            every brief</label
          >
          <label for="new-reason">Why?</label>
          <input id="new-reason" class="input" name="reason" [(ngModel)]="draft.reason" required />
          <div class="actions">
            <button type="button" class="btn btn--ghost" (click)="adding.set(false)">Cancel</button>
            <button
              type="submit"
              class="btn btn--primary"
              [disabled]="busy() || !draft.title.trim() || !draft.reason.trim()"
            >
              Add entry
            </button>
          </div>
        </form>
      } @else {
        <button type="button" class="btn" (click)="adding.set(true)">Add an entry</button>
      }
    </section>

    @if (v.retiredEntries.length) {
      <details class="panel retired">
        <summary>Retired entries ({{ v.retiredEntries.length }}) — kept in the archive</summary>
        <ul class="list-reset">
          @for (e of v.retiredEntries; track e.id) {
            <li>
              <a [routerLink]="['/archive', e.id]">{{ e.title }}</a>
              <span class="meta"> — {{ e.retiredReason }}</span>
            </li>
          }
        </ul>
      </details>
    }
  `,
  styles: `
    .links {
      display: inline-flex;
      gap: var(--space-3);
      letter-spacing: normal;
      text-transform: none;
      a {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
      }
    }
    .inline {
      min-height: auto;
      padding: 0 var(--space-1);
    }
    .entries {
      display: flex;
      flex-direction: column;
      margin: var(--space-4) 0;
    }
    .entry {
      padding: var(--space-4) 0;
      border-top: var(--border-width) solid var(--color-border);
    }
    .entry-head {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
      h3 {
        font-size: var(--font-size-md);
      }
    }
    .body {
      margin: var(--space-2) 0;
      white-space: pre-wrap;
    }
    .row-actions {
      display: flex;
      gap: var(--space-1);
      .btn {
        min-height: auto;
        padding: 0 var(--space-2);
        font-size: var(--font-size-sm);
      }
    }
    .check {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-weight: var(--font-weight-regular);
    }
    .add {
      padding-top: var(--space-4);
      border-top: var(--border-width) solid var(--color-border);
    }
    .retired summary {
      cursor: pointer;
      color: var(--color-text-muted);
    }
    .retired ul {
      margin-top: var(--space-3);
    }
  `,
})
export class FieldManualTab {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly view = input.required<UnitDetailView>();
  readonly changed = output<void>();

  protected readonly editing = signal<Editing>(null);
  protected readonly adding = signal(false);
  protected readonly retiring = signal<{ id: string; reason: string } | null>(null);
  protected readonly busy = signal(false);
  protected draft = { title: '', body: '', pinned: false, reason: '' };

  protected fieldManualDoc(): DocumentView | null {
    return this.view().documents.find((d) => d.kind === 'field-manual') ?? null;
  }

  protected sourceLink(s: SourceRef): string[] | null {
    if (s.kind === 'handover' && s.id) return ['/units', this.view().unit.id, 'documents', s.id];
    return null;
  }

  protected async saveEdit(e: FmEntryView): Promise<void> {
    const ed = this.editing()!;
    await this.act(async () => {
      await this.api.reviseFmEntry(e.id, {
        title: ed.title,
        body: ed.body,
        reason: ed.reason,
        expectedVersion: e.version,
      });
      this.editing.set(null);
      return {
        message: `“${ed.title}” saved as version ${e.version + 1}.`,
        undo: async () => {
          const current = (await this.api.reviseFmEntry(e.id, {
            title: e.title,
            body: e.body,
            reason: `Undo: ${ed.reason}`,
            expectedVersion: e.version + 1,
          })) as FmEntryView;
          this.toasts.show({
            tone: 'info',
            message: `Restored “${current.title}” as version ${current.version}.`,
          });
          this.changed.emit();
        },
      };
    });
  }

  protected async saveNew(): Promise<void> {
    const d = this.draft;
    await this.act(async () => {
      await this.api.createFmEntry(this.view().unit.id, {
        title: d.title,
        body: d.body,
        pinned: d.pinned,
        reason: d.reason,
      });
      this.draft = { title: '', body: '', pinned: false, reason: '' };
      this.adding.set(false);
      return { message: `“${d.title}” added to the Field Manual.` };
    });
  }

  protected async retire(e: FmEntryView): Promise<void> {
    const reason = this.retiring()!.reason.trim();
    await this.act(async () => {
      const retired = await this.api.retireFmEntry(e.id, e.version, reason);
      this.retiring.set(null);
      return {
        message: `“${e.title}” retired to the archive.`,
        undo: async () => {
          await this.api.reinstateFmEntry(e.id, retired.version, `Undo: ${reason}`);
          this.toasts.show({ tone: 'info', message: `“${e.title}” reinstated.` });
          this.changed.emit();
        },
      };
    });
  }

  protected async sync(): Promise<void> {
    await this.act(async () => {
      const r = await this.api.syncDocuments(this.view().unit.id);
      return {
        message: r.imported.length
          ? `Imported ${r.imported.join(', ')}.`
          : 'No edits in the repository to import.',
      };
    });
  }

  private async act(
    fn: () => Promise<{ message: string; undo?: () => Promise<void> }>,
  ): Promise<void> {
    this.busy.set(true);
    try {
      const r = await fn();
      this.toasts.show({
        tone: 'success',
        message: r.message,
        ...(r.undo ? { undo: r.undo } : {}),
      });
      this.changed.emit();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
