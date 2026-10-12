import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet, NavigationEnd } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { Auth } from '../core/auth';
import { Live } from '../core/live';
import { Meta } from '../core/meta';
import { NeedsYou } from '../core/needs-you';
import { ThemeService } from '../core/theme';
import { Icon } from '../ui/icon';
import type { IconName } from '../ui/icons';
import { Breadcrumbs } from './breadcrumbs';

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
  { label: 'Archive', link: '/archive', icon: 'archive' },
  { label: 'Settings', link: '/settings', icon: 'sliders' },
];

const RAIL_KEY = 'orbot.rail.collapsed';

@Component({
  selector: 'orb-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, Breadcrumbs],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
  host: { '[class.collapsed]': 'collapsed()', '[class.drawer-open]': 'drawerOpen()' },
})
export class Shell {
  protected readonly meta = inject(Meta);
  protected readonly theme = inject(ThemeService);
  protected readonly live = inject(Live);
  protected readonly needsYou = inject(NeedsYou);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);

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
