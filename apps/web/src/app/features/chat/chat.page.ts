import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { UnitView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { PageTitle } from '../../core/title';
import { ChatPanel } from './chat-panel';

/** Full-page chat: every channel in a list, one conversation open. `?m=` deep-links a message. */
@Component({
  selector: 'orb-chat-page',
  imports: [RouterLink, ChatPanel],
  template: `
    <div class="page chat-page">
      <nav class="channels panel" aria-label="Channels">
        <h1 class="panel__title">Chat</h1>
        <ul class="list-reset">
          <li>
            <a routerLink="/chat/hq" [attr.aria-current]="channel() === 'hq' ? 'page' : null">HQ</a>
          </li>
          @for (u of units(); track u.id) {
            <li>
              <a
                [routerLink]="['/chat', u.id]"
                [attr.aria-current]="channel() === u.id ? 'page' : null"
                >{{ u.name }} Overseer</a
              >
            </li>
          }
        </ul>
        <a class="meta" routerLink="/orders">Orders log →</a>
      </nav>
      <section class="conversation panel" [attr.aria-label]="'Conversation with ' + label()">
        <h2 class="panel__title">{{ label() }}</h2>
        <orb-chat-panel [channel]="channel()" [highlight]="m() ?? null" />
      </section>
    </div>
  `,
  styles: `
    .chat-page {
      display: grid;
      grid-template-columns: minmax(var(--space-16), var(--card-min-width)) minmax(0, 1fr);
      gap: var(--space-4);
      height: calc(var(--viewport-height) - var(--header-height));
      max-width: none;
    }
    .channels {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      ul {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      a[aria-current='page'] {
        color: var(--color-text);
        font-weight: var(--font-weight-semibold);
      }
      li a {
        display: block;
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-md);
      }
    }
    .conversation {
      display: flex;
      flex-direction: column;
      min-height: 0;
      orb-chat-panel {
        flex: 1;
        min-height: 0;
      }
    }
    @media (max-width: 48rem) {
      .chat-page {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto minmax(0, 1fr);
      }
      .channels ul {
        flex-direction: row;
        flex-wrap: wrap;
      }
    }
  `,
})
export class ChatPage {
  readonly channel = input<string, string | undefined>('hq', { transform: (v) => v ?? 'hq' });
  readonly m = input<string>();
  private readonly list = httpResource<UnitView[]>(() => apiUrl.units());
  protected readonly units = computed(() => this.list.value() ?? []);
  protected readonly label = computed(() => {
    if (this.channel() === 'hq') return 'HQ';
    const u = this.units().find((x) => x.id === this.channel());
    return u ? `${u.name} Overseer` : 'Overseer';
  });

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      crumbs.set([ORBAT_CRUMB, { label: 'Chat', link: '/chat/hq' }, { label: this.label() }]);
      title.set(`Chat · ${this.label()}`);
    });
  }
}
