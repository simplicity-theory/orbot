import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  STATUS_META,
  type AppManifest,
  type AppProgressView,
  type ServerApp,
  type Status,
} from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Can } from '../../ui/can';
import { RelativeTimePipe } from '../../ui/relative-time';
import { StatusBadge } from '../../ui/status-badge';
import { Toasts } from '../../ui/toast';

const STATUS: Record<ServerApp['status'], Status> = {
  installing: 'working',
  removing: 'working',
  running: 'done',
  failed: 'failed',
  removed: 'stood-down',
};
const SAYS: Record<ServerApp['status'], string> = {
  installing: 'Installing',
  removing: 'Removing',
  running: 'Installed',
  failed: 'Failed',
  removed: 'Removed',
};

/** One app on a server: how it is doing, its live log while it installs, and what to do with it. */
@Component({
  selector: 'orb-server-app',
  imports: [Can, RelativeTimePipe, RouterLink, StatusBadge],
  template: `
    @let a = app();
    <div class="head">
      <h3>{{ a.name }}</h3>
      <orb-status [status]="status()" />
      @if (says(); as w) {
        <span class="says">{{ w }}</span>
      }
    </div>
    @if (a.message) {
      <p class="message" [class.bad]="a.status === 'failed'">{{ a.message }}</p>
    }
    <dl class="dl facts">
      @for (kv of shown(); track kv[0]) {
        <dt>{{ kv[0] }}</dt>
        <dd class="mono">{{ kv[1] }}</dd>
      }
      @if (a.report; as r) {
        <dt>Health</dt>
        <dd>
          service {{ r['service'] || '?' }} · API {{ r['health'] || '?' }}
          @if (r['models']) {
            · serves <span class="mono">{{ r['models'] }}</span>
          }
        </dd>
        @if (r['gpu']) {
          <dt>GPU now</dt>
          <dd>{{ r['gpu'] }}</dd>
        }
      }
      <dt>{{ a.finishedAt ? 'Finished' : 'Started' }}</dt>
      <dd>{{ a.finishedAt ?? a.startedAt | relativeTime }}</dd>
    </dl>
    @if (a.provides.length && a.status === 'running') {
      <p class="meta">
        It serves a model:
        <a routerLink="/supply" [queryParams]="{ section: 'models' }">see Models in the depot</a>.
      </p>
    }
    @if (following()) {
      <div class="log-head">
        <span class="meta">Live log from the server</span>
        @if (progress(); as p) {
          <span class="meta mono">{{ p.state }}</span>
        }
      </div>
      <pre class="log" tabindex="0" [attr.aria-label]="a.name + ' log'">{{
        progress()?.log || 'Waiting for the first lines…'
      }}</pre>
    } @else if (a.status === 'failed') {
      <details (toggle)="loadLog()">
        <summary>Show the log</summary>
        <pre class="log" tabindex="0">{{ progress()?.log || 'Loading…' }}</pre>
      </details>
    }
    <div class="actions" *orbCan="null">
      @if (a.status === 'running') {
        <button type="button" class="btn small" [disabled]="busy()" (click)="refresh()">
          Refresh status
        </button>
      }
      @if (!following() && manifest()) {
        <button type="button" class="btn small" [disabled]="busy()" (click)="reinstall.emit()">
          {{ a.status === 'removed' ? 'Install again' : 'Change settings / reinstall' }}
        </button>
      }
      @if (a.status === 'running' || a.status === 'failed') {
        <button type="button" class="btn small" [disabled]="busy()" (click)="remove()">
          Remove
        </button>
      }
    </div>
  `,
  host: { class: 'panel' },
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
      h3 {
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-semibold);
      }
    }
    .says {
      font-weight: var(--font-weight-medium);
    }
    .message {
      color: var(--color-text-muted);
      overflow-wrap: anywhere;
      &.bad {
        color: var(--tone-danger);
      }
    }
    .facts {
      font-size: var(--font-size-sm);
      dd {
        overflow-wrap: anywhere;
      }
    }
    .log-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .log {
      max-height: calc(var(--space-16) * 4);
      overflow: auto;
      margin: 0;
      padding: var(--space-3);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      font-family: var(--font-mono);
      font-size: var(--font-size-xs);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    summary {
      cursor: pointer;
    }
    p a {
      text-decoration: underline;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .small {
      min-height: auto;
      padding: var(--space-1) var(--space-3);
    }
  `,
})
export class ServerAppCard {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly serverId = input.required<string>();
  readonly app = input.required<ServerApp>();
  readonly manifest = input<AppManifest | null>(null);
  readonly reinstall = output<void>();
  readonly changed = output<void>();
  protected readonly busy = signal(false);
  protected readonly progress = signal<AppProgressView | null>(null);

  protected readonly status = computed(() => STATUS[this.app().status]);
  /** Said in words only where the status badge does not already say it. */
  protected readonly says = computed(() => {
    const w = SAYS[this.app().status];
    return w === STATUS_META[this.status()].label ? null : w;
  });
  protected readonly following = computed(
    () => this.app().status === 'installing' || this.app().status === 'removing',
  );
  /** The settings worth a glance, labelled as the manifest labels them. */
  protected readonly shown = computed(() => {
    const settings = this.app().settings;
    // In the manifest's order (the record does not keep the order keys were written in).
    const defs =
      this.manifest()?.settings ?? Object.keys(settings).map((key) => ({ key, label: key }));
    return defs
      .filter((d) => settings[d.key] !== undefined && settings[d.key] !== '')
      .map((d) => [d.label, String(settings[d.key])] as const);
  });

  constructor() {
    // While it installs, read its log from the server every few seconds.
    let timer: ReturnType<typeof setInterval> | undefined;
    effect(() => {
      clearInterval(timer);
      if (!this.following()) return;
      void this.loadLog();
      timer = setInterval(() => void this.loadLog(), 3000);
    });
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected async loadLog(): Promise<void> {
    try {
      this.progress.set(await this.api.appProgress(this.serverId(), this.app().id));
    } catch {
      // The server may be busy or unreachable for a moment; the next read tries again.
    }
  }

  protected refresh(): Promise<void> {
    return this.act(async () => {
      await this.api.appStatus(this.serverId(), this.app().id);
      return `Read ${this.app().name}'s status from the server.`;
    });
  }

  protected remove(): Promise<void> {
    return this.act(async () => {
      await this.api.uninstallApp(this.serverId(), this.app().id);
      return `Removing ${this.app().name}. What it downloaded stays on the server.`;
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
