import { Dialog } from '@angular/cdk/dialog';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet, NavigationEnd } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { Auth } from '../core/auth';
import { ChatLauncher } from '../core/chat-drawer';
import { Live } from '../core/live';
import { Meta } from '../core/meta';
import { NeedsYou } from '../core/needs-you';
import { ThemeService } from '../core/theme';
import { Icon } from '../ui/icon';
import type { IconName } from '../ui/icons';
import { Backbrief } from '../ui/backbrief';
import { openDialog } from '../ui/dialog';
import { Breadcrumbs } from './breadcrumbs';
import { CommandPalette } from './command-palette';
import { ShortcutsDialog } from './shortcuts-dialog';

interface NavItem {
  label: string;
  link: string;
  icon: IconName;
  exact?: boolean;
}

const NAV: NavItem[] = [
  { label: 'ORBAT', link: '/', icon: 'grid', exact: true },
  { label: 'Operations', link: '/operations', icon: 'flag' },
  { label: 'Approvals', link: '/approvals', icon: 'stamp' },
  { label: 'Sitreps', link: '/sitreps', icon: 'radio' },
  { label: 'Chat', link: '/chat', icon: 'user' },
  { label: 'Orders log', link: '/orders', icon: 'book' },
  { label: 'Supply Depot', link: '/supply', icon: 'key' },
  { label: 'Archive', link: '/archive', icon: 'archive' },
  { label: 'Settings', link: '/settings', icon: 'sliders' },
];

const RAIL_KEY = 'orbot.rail.collapsed';

/** `g` then a key: go to a screen. */
const GO_TO: Record<string, string> = {
  o: '/',
  a: '/approvals',
  s: '/sitreps',
  r: '/archive',
  p: '/operations',
  ',': '/settings',
  c: '/chat',
  l: '/orders',
  d: '/supply',
};

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

const POPOVER: ConnectedPosition[] = [
  { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 8 },
];

@Component({
  selector: 'orb-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    Icon,
    Breadcrumbs,
    CdkConnectedOverlay,
    CdkOverlayOrigin,
    CdkTrapFocus,
    Backbrief,
  ],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
  host: {
    '[class.collapsed]': 'collapsed()',
    '[class.drawer-open]': 'drawerOpen()',
    '(document:keydown)': 'onKey($event)',
  },
})
export class Shell {
  protected readonly meta = inject(Meta);
  protected readonly theme = inject(ThemeService);
  protected readonly live = inject(Live);
  protected readonly needsYou = inject(NeedsYou);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly dialog = inject(Dialog);
  protected readonly chat = inject(ChatLauncher);
  private pendingG: ReturnType<typeof setTimeout> | null = null;
  protected readonly inboxOpen = signal(false);
  protected readonly popover = POPOVER;
  protected readonly isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  protected readonly nav = NAV;
  protected readonly collapsed = signal(readCollapsed());
  /** Off-canvas rail on narrow screens. */
  protected readonly drawerOpen = signal(false);
  protected readonly principal = computed(() => this.auth.principal());

  constructor() {
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.drawerOpen.set(false));
  }

  protected openPalette(): void {
    if (this.dialog.openDialogs.some((d) => d.componentInstance instanceof CommandPalette)) return;
    this.dialog.closeAll();
    this.dialog.open(CommandPalette, {
      panelClass: ['orb-dialog', 'orb-palette'],
      backdropClass: 'orb-dialog-backdrop',
      ariaLabel: 'Command palette',
      autoFocus: false,
      restoreFocus: true,
    });
  }

  protected onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.openPalette();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || this.dialog.openDialogs.length)
      return;
    if (this.pendingG) {
      clearTimeout(this.pendingG);
      this.pendingG = null;
      const to = GO_TO[e.key];
      if (to) {
        e.preventDefault();
        void this.router.navigateByUrl(to);
      }
      return;
    }
    if (e.key === 'c') {
      e.preventDefault();
      this.chat.open();
    } else if (e.key === 'g') {
      this.pendingG = setTimeout(() => (this.pendingG = null), 1500);
    } else if (e.key === '?') {
      e.preventDefault();
      openDialog(this.dialog, ShortcutsDialog, null, 'Keyboard shortcuts');
    }
  }

  protected toggleRail(): void {
    this.collapsed.update((c) => !c);
    try {
      localStorage.setItem(RAIL_KEY, String(this.collapsed()));
    } catch {
      /* storage unavailable */
    }
  }

  protected badgeFor(item: NavItem): number {
    return item.link === '/approvals' ? this.needsYou.approvals() : 0;
  }

  protected async signOut(): Promise<void> {
    this.live.disconnect();
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }

  protected focusMain(event: Event): void {
    event.preventDefault();
    document.getElementById('main')?.focus();
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === 'true';
  } catch {
    return false;
  }
}
