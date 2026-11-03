import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { RecordEvent } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Icon } from '../../ui/icon';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

let seq = 0;

/** The Overseer's structured reply: what changed (with links and Undo), what it needs from you. */
@Component({
  selector: 'orb-readback',
  imports: [FormsModule, RouterLink, Icon, Term],
  template: `
    @let rb = readback().body;
    <div class="card" [class.wilco]="rb.items.length > 0">
      <p class="headline">
        @if (rb.items.length) {
          <orb-term key="wilco">Wilco.</orb-term>
        } @else {
          {{ rb.text }}
        }
      </p>
      @if (rb.items.length && rb.answer) {
        <p>{{ rb.answer }}</p>
      }

      @if (rb.items.length) {
        <ul class="list-reset changes" aria-label="Changes made">
          @for (item of rb.items; track item.ordersLogId) {
            @let undone = reversed()[item.ordersLogId];
            <li [class.undone]="undone">
              <orb-icon class="sm" [name]="undone ? 'undo' : 'check'" />
              <div class="change">
                <p>
                  @if (item.routedVia) {
                    <span class="chip">via HQ</span>
                  }
                  {{ item.summary }}
                  @if (undone) {
                    <span class="chip">Undone</span>
                  }
                </p>
                <p class="links">
                  @for (l of item.links; track l.link + l.label) {
                    <a [routerLink]="path(l.link)" [queryParams]="query(l.link)">{{ l.label }}</a>
                  }
                  <a routerLink="/orders" [queryParams]="{ entry: item.ordersLogId }">Orders log</a>
                </p>
              </div>
              @if (item.reversible && !undone) {
                <button
                  type="button"
                  class="btn btn--ghost small"
                  [disabled]="busy()"
                  (click)="undo(item.ordersLogId, item.summary)"
                >
                  <orb-icon class="sm" name="undo" /> Undo
                </button>
              }
            </li>
          }
        </ul>
      }

      @for (p of rb.pending; track p.pendingId) {
        @let outcome = resolved()[p.pendingId];
        <div class="pending" [attr.data-reason]="p.reason">
          <p>
            @if (p.reason === 'musing') {
              You said something that sounds like it might be an order:
              <strong>{{ p.summary }}</strong
              >.
            } @else if (p.reason === 'offer') {
              I could: <strong>{{ p.summary }}</strong
              >.
            } @else {
              <strong>{{ p.summary }}.</strong> This cannot be undone.
            }
          </p>
          @if (outcome) {
            <p class="meta">
              {{
                outcome === 'confirmed'
                  ? 'You confirmed it — done.'
                  : 'You said no — nothing changed.'
              }}
            </p>
          } @else if (p.reason === 'musing' || p.reason === 'offer') {
            <div class="actions">
              <button
                type="button"
                class="btn btn--primary"
                [disabled]="busy()"
                (click)="confirm(p.pendingId)"
              >
                {{ p.reason === 'offer' ? 'Do it' : 'Yes, do it' }}
              </button>
              <button type="button" class="btn" [disabled]="busy()" (click)="decline(p.pendingId)">
                {{ p.reason === 'offer' ? 'Not now' : 'No' }}
              </button>
            </div>
          } @else {
            <form class="confirm" (ngSubmit)="confirm(p.pendingId, phrase)">
              <label [for]="id + p.pendingId">Type “{{ p.phrase }}” to go ahead</label>
              <input
                class="input"
                [id]="id + p.pendingId"
                name="phrase"
                autocomplete="off"
                [(ngModel)]="phrase"
              />
              <button
                type="submit"
                class="btn btn--primary"
                [disabled]="
                  busy() || phrase.trim().toLowerCase() !== (p.phrase ?? '').toLowerCase()
                "
              >
                Confirm
              </button>
              <button type="button" class="btn" [disabled]="busy()" (click)="decline(p.pendingId)">
                Cancel
              </button>
            </form>
          }
        </div>
      }

      @if (rb.missing.length) {
        <div class="missing">
          <p>
            Not connected in the <orb-term key="supply-depot">Supply Depot</orb-term>:
            {{ rb.missing.join(', ') }}.
          </p>
          <a class="btn" routerLink="/supply" [queryParams]="{ connect: rb.missing[0] }"
            ><orb-icon class="sm" name="key" /> Open Supply Depot</a
          >
        </div>
      }
      @if (rb.unclear.length) {
        <ul class="unclear">
          @for (u of rb.unclear; track $index) {
            <li>Not understood: “{{ u }}”</li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .headline {
      font-weight: var(--font-weight-semibold);
    }
    .wilco .headline {
      color: var(--tone-success);
    }
    .changes li {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      padding: var(--space-2) 0;
      border-top: var(--border-width) solid var(--color-border);
      orb-icon {
        margin-top: var(--space-1);
        color: var(--tone-success);
      }
      &.undone {
        color: var(--color-text-muted);
        orb-icon {
          color: var(--color-text-subtle);
        }
      }
    }
    .change {
      flex: 1;
      min-width: 0;
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      font-size: var(--font-size-sm);
      a {
        display: inline-flex;
        align-items: center;
        min-height: var(--space-6);
      }
    }
    .small {
      min-height: auto;
      padding: 0 var(--space-2);
      font-size: var(--font-size-sm);
    }
    .chip {
      margin: 0 var(--space-1);
    }
    .pending,
    .missing {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-3);
      border: var(--border-width) solid var(--tone-warning);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--tone-warning) 8%, transparent);
    }
    .pending[data-reason='irreversible'] {
      border-color: var(--tone-danger);
      background: color-mix(in srgb, var(--tone-danger) 8%, transparent);
    }
    .actions,
    .confirm {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }
    .confirm label {
      flex-basis: 100%;
      font-size: var(--font-size-sm);
    }
    .missing .btn {
      align-self: flex-start;
    }
    .unclear {
      margin: 0;
      padding-left: var(--space-5);
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
    }
  `,
})
export class ReadbackCard {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly readback = input.required<RecordEvent<'chat.readback'>>();
  readonly reversed = input<Record<string, string>>({});
  readonly resolved = input<Record<string, 'confirmed' | 'declined'>>({});
  readonly changed = output<void>();
  protected readonly busy = signal(false);
  protected readonly id = `rb-${seq++}-`;
  protected phrase = '';

  /** Links from the API may carry a query string; split it for routerLink. */
  protected path(link: string): string {
    return link.split('?')[0]!;
  }
  protected query(link: string): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(link.split('?')[1] ?? ''));
  }

  protected undo(entryId: string, summary: string): Promise<void> {
    return this.act(async () => {
      const r = await this.api.undoOrder(entryId);
      return `Undone: ${summary} (${r.summary})`;
    });
  }

  protected confirm(pendingId: string, phrase?: string): Promise<void> {
    return this.act(async () => {
      const r = await this.api.confirmPending(pendingId, phrase);
      this.phrase = '';
      return r.body.items[0]?.summary ?? 'Done.';
    });
  }

  protected decline(pendingId: string): Promise<void> {
    return this.act(async () => {
      await this.api.declinePending(pendingId);
      return 'Understood — nothing changed.';
    });
  }

  private async act(fn: () => Promise<string>): Promise<void> {
    this.busy.set(true);
    try {
      this.toasts.show({ tone: 'success', message: await fn() });
      this.changed.emit();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
