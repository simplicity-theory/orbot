import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { RecordEvent } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Can } from '../../ui/can';
import { Icon } from '../../ui/icon';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { StatusBadge } from '../../ui/status-badge';
import { Toasts } from '../../ui/toast';

/** 982240026624 → "982 GB" (as df -H counts). */
export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** The server's last health check: login, apps, disks; and a button to run one now. */
@Component({
  selector: 'orb-server-health',
  imports: [Can, Icon, RelativeTimePipe, StatusBadge],
  template: `
    <div class="head">
      <h2 id="health-h" class="panel__title">Health</h2>
      @if (health(); as h) {
        <orb-status [status]="h.body.status" />
        <span class="meta" [title]="full(h.createdAt)"
          >checked {{ h.createdAt | relativeTime }}</span
        >
      } @else {
        <span class="meta">not checked yet</span>
      }
      <button
        *orbCan="null"
        type="button"
        class="btn small run"
        [disabled]="running()"
        (click)="run()"
      >
        {{ running() ? 'Checking…' : 'Run health check' }}
      </button>
    </div>
    @if (health(); as h) {
      <ul class="list-reset checks">
        <li>
          <orb-icon
            class="sm"
            [name]="h.body.login.ok ? 'check' : 'x'"
            [class.bad]="!h.body.login.ok"
          />
          <span><strong>Login</strong> {{ h.body.login.message }}</span>
        </li>
        @if (h.body.workspace; as w) {
          <li>
            <orb-icon class="sm" [name]="w.ok ? 'check' : 'triangle-alert'" [class.warn]="!w.ok" />
            <span><strong>Bot workspace</strong> {{ w.message }}</span>
          </li>
        }
        @for (a of h.body.apps; track a.appId) {
          <li>
            <orb-icon
              class="sm"
              [name]="
                a.status === 'healthy' ? 'check' : a.status === 'down' ? 'x' : 'triangle-alert'
              "
              [class.bad]="a.status === 'down'"
              [class.warn]="a.status === 'degraded'"
            />
            <span
              ><strong>{{ a.name }}</strong> {{ a.message }}</span
            >
          </li>
        } @empty {
          <li class="meta">No apps installed.</li>
        }
      </ul>
      @if (h.body.disks.length) {
        <h3 class="sub">Disk space</h3>
        <ul class="list-reset disks">
          @for (d of h.body.disks; track d.mount) {
            <li [attr.data-state]="d.status">
              <span class="mount mono">{{ d.mount }}</span>
              <span
                class="bar"
                role="meter"
                [attr.aria-label]="'Disk ' + d.mount"
                aria-valuemin="0"
                aria-valuemax="100"
                [attr.aria-valuenow]="d.usedPercent"
                [attr.aria-valuetext]="d.usedPercent + '% used'"
                ><span class="fill" [style.width.%]="d.usedPercent"></span
              ></span>
              <span class="text"
                >{{ bytes(d.availBytes) }} free of {{ bytes(d.sizeBytes) }} · {{ d.usedPercent }}%
                used</span
              >
            </li>
          }
        </ul>
      }
    } @else {
      <p class="meta">
        A health check logs in, asks each installed app how it is doing, and reads the free disk
        space.
      </p>
    }
  `,
  host: { class: 'panel', role: 'region', 'aria-labelledby': 'health-h' },
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      .panel__title {
        margin-bottom: 0;
      }
    }
    .run {
      margin-left: auto;
    }
    .small {
      min-height: auto;
      padding: var(--space-1) var(--space-3);
    }
    .checks {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      li {
        display: flex;
        align-items: flex-start;
        gap: var(--space-2);
        overflow-wrap: anywhere;
      }
      orb-icon {
        flex: none;
        margin-top: var(--space-1);
        color: var(--tone-success);
        &.warn {
          color: var(--tone-warning);
        }
        &.bad {
          color: var(--tone-danger);
        }
      }
    }
    .sub {
      font-size: var(--font-size-sm);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-muted);
    }
    /* One grid for all rows, so the bars line up whatever the mount names. */
    .disks {
      display: grid;
      grid-template-columns: max-content minmax(0, var(--meter-width)) 1fr;
      align-items: center;
      gap: var(--space-2) var(--space-3);
      li {
        --tone: var(--tone-success);
        display: contents;
        &[data-state='degraded'] {
          --tone: var(--tone-warning);
        }
        &[data-state='down'] {
          --tone: var(--tone-danger);
        }
      }
    }
    .bar {
      position: relative;
      height: var(--space-2);
      border-radius: var(--radius-pill);
      background: var(--color-surface-3);
      overflow: hidden;
    }
    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      background: var(--tone);
    }
    .text {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
    }
    [data-state='degraded'] .text,
    [data-state='down'] .text {
      color: var(--tone);
      font-weight: var(--font-weight-medium);
    }
  `,
})
export class ServerHealth {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly serverId = input.required<string>();
  readonly health = input<RecordEvent<'server.health'> | null>(null);
  /** A check finished: the page reloads. */
  readonly checked = output<void>();
  protected readonly running = signal(false);
  protected readonly bytes = bytes;
  protected readonly full = fullDate;
  /** The last check is missing or more than 10 minutes old. */
  readonly stale = computed(() => {
    const h = this.health();
    return !h || Date.now() - Date.parse(h.createdAt) > 10 * 60_000;
  });

  async run(): Promise<void> {
    if (this.running()) return;
    this.running.set(true);
    try {
      const h = await this.api.serverHealth(this.serverId());
      this.toasts.show({
        tone:
          h.body.status === 'healthy' ? 'success' : h.body.status === 'down' ? 'danger' : 'info',
        message: `${h.body.server} is ${h.body.status}.`,
      });
      this.checked.emit();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.running.set(false);
    }
  }
}
