import { httpResource } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WHISPER_MAX, type WhisperView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { EmptyState } from '../../ui/empty-state';
import { LoadError } from '../../ui/load-error';
import { RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';

/** Nothing on the record changes when a note comes or goes, so the board is read again on a clock. */
const REFRESH_MS = 30_000;

/**
 * The whispers board: unsigned notes anyone can leave and anyone can read. Bots overhear a
 * few in their brief. Nothing here is recorded, attributed or kept: notes fade at random.
 */
@Component({
  selector: 'orb-whispers-page',
  imports: [FormsModule, EmptyState, LoadError, Skeleton, RelativeTimePipe],
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1>Whispers</h1>
          <p class="page-header__lede">
            Unsigned notes anyone can leave and anyone can read; the bots overhear a few before each
            task. Nothing here says who wrote it or who read it, nothing is kept on the record, and
            each note fades at random.
          </p>
        </div>
      </header>

      <form class="panel form whisper" (ngSubmit)="leave()">
        <label for="whisper-text">Leave a whisper</label>
        <textarea
          id="whisper-text"
          name="text"
          class="input"
          rows="2"
          [maxlength]="max"
          [(ngModel)]="text"
          [disabled]="busy()"
          placeholder="A hunch, a tip, a thing that bit you…"
        ></textarea>
        <div class="actions">
          <span class="hint">{{ text().length }} / {{ max }}</span>
          <button type="submit" class="btn btn--primary" [disabled]="busy() || !text().trim()">
            Whisper
          </button>
        </div>
        @if (error(); as e) {
          <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
        }
      </form>

      @if (board.error(); as err) {
        <orb-load-error [error]="err" (retry)="board.reload()" />
      } @else if (board.hasValue()) {
        @if (board.value().length) {
          <ol class="list-reset stack" aria-label="The board">
            @for (w of board.value(); track w.id) {
              <li class="panel note">
                <p class="text">{{ w.text }}</p>
                <p class="meta">Heard {{ w.at | relativeTime }}</p>
              </li>
            }
          </ol>
        } @else {
          <orb-empty-state icon="whisper" title="Nothing on the board"
            >Whatever was here has faded. Leave something.</orb-empty-state
          >
        }
      } @else {
        <orb-skeleton [lines]="4" />
      }
    </div>
  `,
  styles: `
    .whisper {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin-bottom: var(--space-4);
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .hint {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
    }
    .stack {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .note .text {
      margin: 0;
      font-style: italic;
    }
    .meta {
      margin: var(--space-1) 0 0;
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
    }
  `,
})
export class WhispersPage {
  private readonly api = inject(Api);
  protected readonly max = WHISPER_MAX;
  protected readonly board = httpResource<WhisperView[]>(() => apiUrl.whispers());
  protected readonly text = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<{ message: string; action: string } | null>(null);

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Whispers' }]);
    const timer = setInterval(() => this.board.reload(), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected async leave(): Promise<void> {
    const text = this.text().trim();
    if (!text || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.whisper(text);
      this.text.set('');
      this.board.reload();
    } catch (e) {
      this.error.set(toUserError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
