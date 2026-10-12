import { Dialog, DialogRef } from '@angular/cdk/dialog';
import {
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
  type AfterViewInit,
} from '@angular/core';
import { Router } from '@angular/router';
import type { PaletteItem } from '@orbot/shared';
import { Api } from '../core/api';
import { toUserError } from '../core/api-error';
import { ThemeService } from '../core/theme';
import { openDialog } from '../ui/dialog';
import { Icon } from '../ui/icon';
import type { IconName } from '../ui/icons';
import { Toasts } from '../ui/toast';
import { AddBotDialog, type AddBotData } from '../features/units/add-bot.dialog';
import { NewMissionDialog, type NewMissionData } from '../features/units/new-mission.dialog';
import { ShortcutsDialog } from './shortcuts-dialog';

interface Command {
  id: string;
  group:
    | 'Actions'
    | 'Go to'
    | 'Units'
    | 'Bots'
    | 'Tasks'
    | 'Missions'
    | 'Operations'
    | 'Documents'
    | 'Search';
  label: string;
  sublabel: string;
  icon: IconName;
  run: () => void | Promise<void>;
}

const KIND_GROUP: Record<PaletteItem['kind'], Command['group']> = {
  unit: 'Units',
  bot: 'Bots',
  task: 'Tasks',
  mission: 'Missions',
  operation: 'Operations',
  document: 'Documents',
};
const KIND_ICON: Record<PaletteItem['kind'], IconName> = {
  unit: 'users',
  bot: 'bot',
  task: 'flag',
  mission: 'flag',
  operation: 'flag',
  document: 'file-text',
};
const MAX = 40;

/** Ctrl/Cmd+K: jump anywhere, run common actions, or search the record. */
@Component({
  selector: 'orb-command-palette',
  imports: [Icon],
  template: `
    <div class="palette">
      <label for="palette-input" class="visually-hidden">Command or destination</label>
      <div class="input-row">
        <orb-icon name="search" />
        <input
          #input
          id="palette-input"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="palette-list"
          [attr.aria-expanded]="results().length > 0"
          [attr.aria-activedescendant]="results()[active()] ? 'cmd-' + active() : null"
          placeholder="Jump to a unit, bot, task or document, or run a command…"
          autocomplete="off"
          [value]="query()"
          (input)="query.set($any($event.target).value); active.set(0)"
          (keydown)="onKey($event)"
        />
        <kbd>Esc</kbd>
      </div>
      <ul id="palette-list" role="listbox" class="list-reset" aria-label="Results">
        @for (c of results(); track c.id; let i = $index) {
          @if (i === 0 || results()[i - 1]!.group !== c.group) {
            <li role="presentation" class="group">{{ c.group }}</li>
          }
          <li
            role="option"
            [id]="'cmd-' + i"
            [attr.aria-selected]="i === active()"
            (mousemove)="active.set(i)"
            (click)="choose(c)"
          >
            <orb-icon class="sm" [name]="c.icon" />
            <span class="label">{{ c.label }}</span>
            <span class="sub">{{ c.sublabel }}</span>
          </li>
        } @empty {
          <li class="empty" role="presentation">No matches. Press Enter to search the record.</li>
        }
      </ul>
      <p class="footer meta">
        <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to choose · <kbd>?</kbd> for all
        shortcuts
      </p>
    </div>
  `,
  styles: `
    .palette {
      display: flex;
      flex-direction: column;
      max-height: calc(var(--viewport-height) - var(--space-16) * 2);
    }
    .input-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding-bottom: var(--space-3);
      border-bottom: var(--border-width) solid var(--color-border);
      input {
        flex: 1;
        border: 0;
        background: none;
        color: var(--color-text);
        font: inherit;
        font-size: var(--font-size-lg);
        &:focus {
          outline: none;
        }
      }
    }
    ul {
      overflow-y: auto;
      margin-top: var(--space-2);
    }
    .group {
      padding: var(--space-2) var(--space-2) var(--space-1);
      color: var(--color-text-subtle);
      font-size: var(--font-size-xs);
      font-weight: var(--font-weight-semibold);
      letter-spacing: var(--letter-spacing-caps);
      text-transform: uppercase;
    }
    [role='option'] {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-height: var(--row-height-dense);
      padding: 0 var(--space-2);
      border-radius: var(--radius-md);
      cursor: pointer;
      &[aria-selected='true'] {
        background: var(--color-surface-3);
        box-shadow: inset calc(var(--border-width) * 3) 0 0 var(--color-accent);
      }
    }
    .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sub {
      color: var(--color-text-subtle);
      font-size: var(--font-size-sm);
      white-space: nowrap;
    }
    .empty {
      padding: var(--space-4) var(--space-2);
      color: var(--color-text-muted);
    }
    .footer {
      margin-top: var(--space-3);
      padding-top: var(--space-2);
      border-top: var(--border-width) solid var(--color-border);
    }
  `,
})
export class CommandPalette implements AfterViewInit {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly theme = inject(ThemeService);
  private readonly toasts = inject(Toasts);
  private readonly dialog = inject(Dialog);
  private readonly ref = inject(DialogRef);
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');

  protected readonly query = signal('');
  protected readonly active = signal(0);
  private readonly index = signal<PaletteItem[]>([]);

  private readonly commands = computed<Command[]>(() => {
    const units = this.index().filter((i) => i.kind === 'unit');
    const go = (label: string, link: string, icon: IconName): Command => ({
      id: `go:${link}`,
      group: 'Go to',
      label,
      sublabel: link,
      icon,
      run: () => this.navigate(link),
    });
    return [
      ...units.map<Command>((u) => ({
        id: `mission:${u.id}`,
        group: 'Actions',
        label: `New mission for ${u.label}`,
        sublabel: 'Overseer drafts a backbrief',
        icon: 'flag',
        run: () =>
          this.later(() =>
            openDialog<boolean, NewMissionData, NewMissionDialog>(
              this.dialog,
              NewMissionDialog,
              { unitId: u.id, unitName: u.label },
              'New mission',
            ),
          ),
      })),
      ...units.map<Command>((u) => ({
        id: `coldstart:${u.id}`,
        group: 'Actions',
        label: `Run cold-start check: ${u.label}`,
        sublabel: 'Could a fresh bot carry on?',
        icon: 'activity',
        run: async () => {
          this.ref.close();
          try {
            const r = await this.api.runColdStart(u.id);
            this.toasts.show({
              tone: r.body.score === 100 ? 'success' : 'info',
              message: `${u.label} cold-start check: ${r.body.score}/100.`,
            });
          } catch (err) {
            const e = toUserError(err);
            this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
          }
        },
      })),
      ...units.map<Command>((u) => ({
        id: `bot:${u.id}`,
        group: 'Actions',
        label: `Add bot to ${u.label}`,
        sublabel: 'Or replace one',
        icon: 'bot',
        run: () =>
          this.later(async () => {
            const view = await this.api.unitView(u.id);
            openDialog<unknown, AddBotData, AddBotDialog>(
              this.dialog,
              AddBotDialog,
              {
                unitId: u.id,
                unitName: u.label,
                bots: view.bots.filter((b) => !b.isOverseer && b.status !== 'stood-down'),
              },
              'Add a bot',
            );
          }),
      })),
      {
        id: 'theme',
        group: 'Actions',
        label: this.theme.theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        sublabel: 'Appearance',
        icon: this.theme.theme() === 'dark' ? 'sun' : 'moon',
        run: () => {
          this.theme.toggle();
          this.ref.close();
        },
      },
      {
        id: 'shortcuts',
        group: 'Actions',
        label: 'Show keyboard shortcuts',
        sublabel: '?',
        icon: 'info',
        run: () =>
          this.later(() => openDialog(this.dialog, ShortcutsDialog, null, 'Keyboard shortcuts')),
      },
      go('ORBAT', '/', 'grid'),
      go('Approvals', '/approvals', 'stamp'),
      go('Sitreps', '/sitreps', 'radio'),
      go('Archive', '/archive', 'archive'),
      go('Operations', '/operations', 'flag'),
      go('Settings', '/settings', 'sliders'),
      ...this.index().map<Command>((i) => ({
        id: `${i.kind}:${i.id}`,
        group: KIND_GROUP[i.kind],
        label: i.label,
        sublabel: i.sublabel,
        icon: KIND_ICON[i.kind],
        run: () => this.navigate(i.link),
      })),
    ];
  });

  protected readonly results = computed<Command[]>(() => {
    const q = this.query().trim().toLowerCase();
    const searchCmd: Command[] = q
      ? [
          {
            id: 'search',
            group: 'Search',
            label: `Search the record for “${this.query().trim()}”`,
            sublabel: 'Archive',
            icon: 'search',
            run: () => this.navigate(`/archive?q=${encodeURIComponent(this.query().trim())}`),
          },
        ]
      : [];
    if (!q)
      return this.commands()
        .filter((c) => c.group === 'Actions' || c.group === 'Go to' || c.group === 'Units')
        .slice(0, MAX);
    const tokens = q.split(/\s+/);
    const scored = this.commands()
      .map((c) => {
        const hay = `${c.label} ${c.sublabel}`.toLowerCase();
        if (!tokens.every((t) => hay.includes(t))) return null;
        const label = c.label.toLowerCase();
        const score =
          (label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2) + (c.group === 'Actions' ? 0.5 : 0);
        return { c, score };
      })
      .filter((x): x is { c: Command; score: number } => !!x)
      .sort((a, b) => a.score - b.score);
    // Keep groups contiguous so group headings read correctly.
    const order: Command['group'][] = [];
    for (const { c } of scored) if (!order.includes(c.group)) order.push(c.group);
    const grouped = order.flatMap((g) => scored.filter((s) => s.c.group === g).map((s) => s.c));
    return [...grouped.slice(0, MAX), ...searchCmd];
  });

  constructor() {
    void this.api.palette().then(
      (items) => this.index.set(items),
      () => this.index.set([]),
    );
  }

  ngAfterViewInit(): void {
    this.input().nativeElement.focus();
  }

  protected onKey(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.active.update((a) => (n ? (a + 1) % n : 0));
      this.scrollActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.active.update((a) => (n ? (a - 1 + n) % n : 0));
      this.scrollActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = this.results()[this.active()];
      if (c) void this.choose(c);
      else if (this.query().trim())
        this.navigate(`/archive?q=${encodeURIComponent(this.query().trim())}`);
    }
  }

  protected choose(c: Command): void | Promise<void> {
    return c.run();
  }

  private scrollActive(): void {
    queueMicrotask(() =>
      document.getElementById(`cmd-${this.active()}`)?.scrollIntoView({ block: 'nearest' }),
    );
  }

  private navigate(link: string): void {
    this.ref.close();
    void this.router.navigateByUrl(link);
  }

  /** Close the palette first, then open what the command asked for (dialogs don't stack well). */
  private later(fn: () => unknown): void {
    this.ref.close();
    setTimeout(() => void fn());
  }
}
