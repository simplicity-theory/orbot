import { Dialog } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { ChatDrawer } from '../features/chat/chat-drawer';

const UNIT_IN_URL = /\/units\/([0-9a-f-]{36})/;

/** Opens the chat drawer, pre-targeted to the Overseer of whatever you are looking at. */
@Injectable({ providedIn: 'root' })
export class ChatLauncher {
  private readonly dialog = inject(Dialog);
  private readonly router = inject(Router);
  private readonly overlay = inject(Overlay);

  /** The channel for the current screen: the unit in the URL, else HQ. */
  contextChannel(): string {
    return UNIT_IN_URL.exec(this.router.url)?.[1] ?? 'hq';
  }

  open(channel = this.contextChannel()): void {
    const open = this.dialog.openDialogs.find((d) => d.componentInstance instanceof ChatDrawer);
    if (open) {
      open.close();
      return;
    }
    this.dialog.open(ChatDrawer, {
      data: { channel },
      panelClass: ['orb-dialog', 'orb-drawer'],
      backdropClass: 'orb-dialog-backdrop',
      ariaLabelledBy: 'chat-drawer-h',
      autoFocus: false,
      restoreFocus: true,
      positionStrategy: this.overlay.position().global().right('0').top('0'),
    });
  }
}
