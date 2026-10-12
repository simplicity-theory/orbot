import { httpResource } from '@angular/common/http';
import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ChatView, RecordEvent } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { reloadOnLive } from '../../core/live';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { Toasts } from '../../ui/toast';
import { ReadbackCard } from './readback-card';

const CHAT_KINDS = new Set(['chat.message', 'chat.readback', 'orders.log', 'pending.resolved']);

/** One conversation with HQ or an Overseer. Used by the drawer and the full-page chat. */
@Component({
  selector: 'orb-chat-panel',
  imports: [FormsModule, ReadbackCard, LoadError, Skeleton, RelativeTimePipe],
  template: `
    <div class="panel-body">
      <div
        class="log"
        #log
        tabindex="0"
        role="log"
        [attr.aria-label]="'Conversation with ' + label()"
        aria-live="polite"
      >
        @if (view.error(); as err) {
          <orb-load-error [error]="err" (retry)="view.reload()" />
        } @else if (view.hasValue()) {
          @let v = view.value();
          @for (item of v.items; track item.id) {
            @if (item.kind === 'chat.readback') {
              <article
                class="msg them"
                [id]="'m-' + item.id"
                [class.highlight]="highlight() === item.id"
                aria-label="Overseer reply"
              >
                <p class="who">
                  {{ v.label }} ·
                  <time [attr.datetime]="item.createdAt" [attr.title]="full(item.createdAt)">{{
                    item.createdAt | relativeTime
                  }}</time>
                </p>
                <orb-readback
                  [readback]="asReadback(item)"
                  [reversed]="v.reversed"
                  [resolved]="v.resolved"
                  (changed)="view.reload()"
                />
              </article>
            } @else {
              @let m = asMessage(item);
              <article
                class="msg"
                [id]="'m-' + item.id"
                [class.mine]="m.body.from === 'commander'"
                [class.them]="m.body.from !== 'commander'"
                [class.relay]="m.body.from === 'hq'"
                [class.highlight]="highlight() === item.id"
                [attr.aria-label]="
                  m.body.from === 'commander' ? 'You' : m.body.from === 'hq' ? 'HQ' : 'Overseer'
                "
              >
                <p class="who">
                  {{
                    m.body.from === 'commander'
                      ? 'You'
                      : m.body.from === 'hq'
                        ? 'HQ (relay)'
                        : v.label
                  }}
                  ·
                  <time [attr.datetime]="item.createdAt" [attr.title]="full(item.createdAt)">{{
                    item.createdAt | relativeTime
                  }}</time>
                </p>
                <p class="text">{{ m.body.text }}</p>
              </article>
            }
          } @empty {
            <p class="empty meta">
              Nothing said yet. Ask a question, or give an order — “Add rate limiting to the API.”,
              “Stop blocking on low-severity findings.” The Overseer reads back exactly what it
              changed.
            </p>
          }
          @if (sending(); as text) {
            <article class="msg mine">
              <p class="who">You</p>
              <p class="text">{{ text }}</p>
            </article>
            <p class="thinking meta" role="status">{{ v.label }} is reading your message…</p>
          }
        } @else {
          <orb-skeleton [lines]="6" />
        }
      </div>

      <form class="composer" (ngSubmit)="send()">
        <label [for]="inputId" class="visually-hidden">Message to {{ label() }}</label>
        <textarea
          #box
          class="input"
          rows="2"
          name="text"
          [id]="inputId"
          [placeholder]="'Message ' + label() + '… (Enter to send, Shift+Enter for a new line)'"
          [(ngModel)]="draft"
          (keydown.enter)="onEnter($event)"
        ></textarea>
        <button type="submit" class="btn btn--primary" [disabled]="!!sending() || !draft.trim()">
          Send
        </button>
      </form>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
    }
    .panel-body {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      min-height: 0;
      height: 100%;
    }
    .log {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--space-2);
    }
    .msg {
      max-width: 90%;
      padding: var(--space-3);
      border-radius: var(--radius-lg);
      border: var(--border-width) solid var(--color-border);
      background: var(--color-surface-2);
      transition: box-shadow var(--duration) var(--ease);
    }
    .mine {
      align-self: flex-end;
      background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface-1));
      border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
    }
    .them {
      align-self: flex-start;
    }
    .relay {
      border-style: dashed;
    }
    .highlight {
      box-shadow: 0 0 0 var(--focus-ring-width) var(--color-focus);
    }
    .who {
      margin-bottom: var(--space-1);
      color: var(--color-text-muted);
      font-size: var(--font-size-xs);
    }
    .text {
      white-space: pre-wrap;
    }
    .composer {
      display: flex;
      gap: var(--space-2);
      align-items: flex-end;
      textarea {
        flex: 1;
        padding: var(--space-2) var(--space-3);
        resize: vertical;
      }
    }
    .empty {
      margin: auto;
      max-width: var(--measure);
      text-align: center;
    }
  `,
})
export class ChatPanel {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly channel = input.required<string>();
  /** A message to scroll to and highlight (deep links). */
  readonly highlight = input<string | null>(null);
  protected readonly view = httpResource<ChatView>(() => apiUrl.chat(this.channel()));
  protected readonly label = computed(() => this.view.value()?.label ?? 'Overseer');
  protected readonly sending = signal<string | null>(null);
  protected readonly full = fullDate;
  protected readonly inputId = `chat-input-${Math.random().toString(36).slice(2, 8)}`;
  protected draft = '';
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');
  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>('box');

  constructor() {
    reloadOnLive(
      (n) =>
        n.type === 'event' &&
        CHAT_KINDS.has(n.event.kind) &&
        (n.event.kind === 'pending.resolved' ||
          (n.event.body as { channel?: string }).channel === this.channel()),
      () => this.view.reload(),
      100,
    );
    // Keep the newest message in view; deep-linked messages win.
    afterRenderEffect(() => {
      const v = this.view.value();
      this.sending();
      const el = this.log()?.nativeElement;
      if (!v || !el) return;
      const target = this.highlight() ? document.getElementById(`m-${this.highlight()}`) : null;
      if (target) target.scrollIntoView({ block: 'center' });
      else el.scrollTop = el.scrollHeight;
    });
  }

  focus(): void {
    this.box()?.nativeElement.focus();
  }

  protected asMessage(e: RecordEvent): RecordEvent<'chat.message'> {
    return e as RecordEvent<'chat.message'>;
  }
  protected asReadback(e: RecordEvent): RecordEvent<'chat.readback'> {
    return e as RecordEvent<'chat.readback'>;
  }

  protected onEnter(e: Event): void {
    if ((e as KeyboardEvent).shiftKey) return;
    e.preventDefault();
    void this.send();
  }

  protected async send(): Promise<void> {
    const text = this.draft.trim();
    if (!text || this.sending()) return;
    this.sending.set(text);
    this.draft = '';
    try {
      await this.api.sendChat(this.channel(), text);
      this.view.reload();
    } catch (err) {
      this.draft = text;
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.sending.set(null);
    }
  }
}
