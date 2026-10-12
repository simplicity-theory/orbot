import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal, viewChild, type AfterViewInit } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { Icon } from '../../ui/icon';
import { ChannelPicker } from './channel-picker';
import { ChatPanel } from './chat-panel';

/** Slide-over chat, one keystroke away on every screen. */
@Component({
  selector: 'orb-chat-drawer',
  imports: [ChatPanel, ChannelPicker, Icon],
  template: `
    <header>
      <h2 id="chat-drawer-h">Chat</h2>
      <orb-channel-picker [channel]="channel()" (picked)="channel.set($event)" />
      <button
        type="button"
        class="btn btn--ghost btn--icon"
        aria-label="Open full-page chat"
        title="Full page"
        (click)="fullPage()"
      >
        <orb-icon name="arrow-right" />
      </button>
      <button
        type="button"
        class="btn btn--ghost btn--icon"
        aria-label="Close chat"
        (click)="ref.close()"
      >
        <orb-icon name="x" />
      </button>
    </header>
    <orb-chat-panel [channel]="channel()" />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      height: 100%;
    }
    header {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      h2 {
        flex: 1;
        font-size: var(--font-size-lg);
      }
    }
    orb-chat-panel {
      flex: 1;
      min-height: 0;
    }
  `,
})
export class ChatDrawer implements AfterViewInit {
  protected readonly ref = inject(DialogRef);
  private readonly router = inject(Router);
  protected readonly channel = signal(inject<{ channel: string }>(DIALOG_DATA).channel);
  private readonly panel = viewChild(ChatPanel);

  constructor() {
    // Following a link from the conversation takes you there: get out of the way.
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.ref.close());
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.panel()?.focus());
  }

  protected fullPage(): void {
    this.ref.close();
    void this.router.navigate(['/chat', this.channel()]);
  }
}
