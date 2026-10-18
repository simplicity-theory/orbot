import { Dialog } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  AppManifest,
  ServerAccess,
  ServerApp,
  ServerDetailView,
  SupplyView,
  UnitView,
} from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive, touchedIds } from '../../core/live';
import { PageTitle } from '../../core/title';
import { Can } from '../../ui/can';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Toasts } from '../../ui/toast';
import { RecordTimeline } from '../tasks/record-timeline';
import { EnvironmentDialog, type EnvironmentDialogData } from './environment.dialog';
import { InstallAppDialog, type InstallAppData } from './install-app.dialog';
import { ServerAppCard } from './server-app';

const FACTS: [key: string, label: string][] = [
  ['os', 'System'],
  ['gpu', 'GPU'],
  ['cpu', 'CPU'],
  ['memory', 'Memory'],
  ['disk', 'Disk'],
  ['docker', 'Docker'],
  ['sudo', 'sudo'],
];

/** A server: what it is, the bot workspace on it, the apps installed there, and its record. */
@Component({
  selector: 'orb-server-page',
  imports: [Can, Icon, LoadError, RecordTimeline, RouterLink, ServerAppCard, Skeleton],
  template: `
    <div class="page page--detail">
      @if (view.error(); as err) {
        <orb-load-error [error]="err" (retry)="view.reload()" />
      } @else if (view.value(); as v) {
        @let sv = server()!;
        <header class="page-header">
          <div>
            <p class="page-header__eyebrow">Server · {{ tier() }}</p>
            <h1>{{ v.supply.name }}</h1>
            <p class="page-header__lede mono">
              {{ sv.user }}&#64;{{ sv.host }}:{{ sv.port }}
              @if (sv.url) {
                · <a [href]="sv.url" target="_blank" rel="noopener">{{ sv.url }}</a>
              }
            </p>
          </div>
          <div class="header-actions" *orbCan="null">
            <button type="button" class="btn" [disabled]="busy()" (click)="check()">
              Check login
            </button>
            <button type="button" class="btn btn--primary" (click)="edit()">Edit</button>
          </div>
        </header>

        @if (sv.facts && sv.facts['sudo'] !== 'passwordless') {
          <p class="panel notice" role="status">
            <orb-icon name="triangle-alert" />
            <span
              >{{ sv.user }} has no passwordless sudo, which installing apps and setting up the bot
              workspace need. Add a line
              <span class="mono">{{ sv.user }} ALL=(ALL) NOPASSWD:ALL</span> in
              <span class="mono">/etc/sudoers.d/orbot</span> on the server, then Check login.</span
            >
          </p>
        }

        <div class="columns">
          <section class="panel" aria-labelledby="what-h">
            <h2 id="what-h" class="panel__title">What it is</h2>
            @if (sv.facts; as f) {
              <dl class="dl">
                @for (x of facts; track x[0]) {
                  @if (f[x[0]]) {
                    <dt>{{ x[1] }}</dt>
                    <dd>{{ f[x[0]] }}</dd>
                  }
                }
              </dl>
            } @else {
              <p class="meta">Not read yet: Check login reads it.</p>
            }
            <details class="keys">
              <summary>{{ sv.fingerprints.length }} pinned host keys</summary>
              @for (k of sv.fingerprints; track k) {
                <div class="meta mono">{{ k }}</div>
              }
            </details>
            <p class="meta held">
              Held by:
              @for (u of holders(); track u.id; let last = $last) {
                <a [routerLink]="['/units', u.id]" [queryParams]="{ section: 'supply' }">{{
                  u.name
                }}</a
                >{{ last ? '' : ', ' }}
              } @empty {
                no unit yet. Issue it in the
                <a routerLink="/supply" [queryParams]="{ section: 'environments' }">Supply Depot</a
                >.
              }
            </p>
          </section>

          <section class="panel" aria-labelledby="ws-h">
            <h2 id="ws-h" class="panel__title">Bot workspace</h2>
            @if (sv.workspace; as ws) {
              <p>
                Bots' dev work runs as <strong class="mono">{{ ws.user }}</strong
                >: its own login, no sudo, not in the docker group, with GPU access. They cannot
                stop or change the apps here.
              </p>
              <p class="meta">
                Login key: <span class="mono">{{ ws.credentialName }}</span> (generated, in the
                secrets store). Folders:
                <span class="mono">~/orbot-dev/&lt;repo&gt;/&lt;bot&gt;</span>.
              </p>
            } @else {
              <p>
                Bots' dev work runs as <strong class="mono">{{ sv.user }}</strong
                >, the login ORBOT uses to install apps. Set up the workspace to give them a login
                of their own without sudo, so they cannot touch what is installed here.
              </p>
              @if (sv.apps.length) {
                <p class="meta">
                  Until then bots are refused dev work on this server, because it runs apps.
                </p>
              }
              <div class="actions" *orbCan="null">
                <button
                  type="button"
                  class="btn btn--primary"
                  [disabled]="busy()"
                  (click)="setupWorkspace()"
                >
                  Set up bot workspace
                </button>
              </div>
            }
          </section>
        </div>

        <section class="apps" aria-labelledby="apps-h">
          <h2 id="apps-h">Apps</h2>
          @if (installed().length) {
            <ul class="list-reset stack" aria-label="Installed apps">
              @for (a of installed(); track a.id) {
                <li>
                  <orb-server-app
                    [serverId]="v.supply.id"
                    [app]="a"
                    [manifest]="manifestOf(a.app)"
                    (reinstall)="install(manifestOf(a.app)!, a)"
                    (changed)="view.reload()"
                  />
                </li>
              }
            </ul>
          }
          @if (available().length) {
            <h3 class="sub">Can be installed</h3>
            <ul class="list-reset catalog" aria-label="Apps that can be installed">
              @for (m of available(); track m.id) {
                <li class="panel">
                  <h4>{{ m.name }}</h4>
                  <p>{{ m.summary }}</p>
                  @if (m.requires.length) {
                    <p class="meta">Needs: {{ m.requires.join('; ') }}.</p>
                  }
                  <div class="actions" *orbCan="null">
                    <button type="button" class="btn" (click)="install(m, null)">
                      Install {{ m.name }}…
                    </button>
                  </div>
                </li>
              }
            </ul>
          }
          <p class="meta">
            Apps come from <span class="mono">deploy/apps</span> in the ORBOT repository: a manifest
            and its install, status and uninstall scripts.
          </p>
        </section>

        <section class="panel" aria-labelledby="rec-h">
          <h2 id="rec-h" class="panel__title">Record</h2>
          @if (v.events.length) {
            <orb-record-timeline [events]="v.events" label="Server record" [newestFirst]="true" />
          } @else {
            <p class="meta">Nothing has run on it yet.</p>
          }
        </section>
      } @else {
        <orb-skeleton variant="block" [lines]="6" />
      }
    </div>
  `,
  styles: `
    .header-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(var(--card-min-width), 1fr));
      gap: var(--space-4);
    }
    .notice {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      border-color: var(--tone-warning);
    }
    .keys {
      margin-top: var(--space-3);
      summary {
        cursor: pointer;
        color: var(--color-text-muted);
      }
      div {
        overflow-wrap: anywhere;
        margin-top: var(--space-1);
      }
    }
    .held {
      margin-top: var(--space-3);
    }
    /* Links inside sentences are underlined: colour alone does not tell them apart. */
    p a {
      text-decoration: underline;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .apps {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      h2 {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
      }
    }
    .sub {
      margin-top: var(--space-2);
      font-size: var(--font-size-md);
      font-weight: var(--font-weight-semibold);
    }
    .stack {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .catalog {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(var(--card-min-width), 1fr));
      gap: var(--space-3);
      h4 {
        font-weight: var(--font-weight-semibold);
        margin-bottom: var(--space-1);
      }
    }
  `,
})
export class ServerPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly dialog = inject(Dialog);
  readonly serverId = input.required<string>();
  protected readonly view = httpResource<ServerDetailView>(() => apiUrl.server(this.serverId()));
  private readonly units = httpResource<UnitView[]>(() => apiUrl.units());
  private readonly supply = httpResource<SupplyView[]>(() => apiUrl.supply());
  protected readonly facts = FACTS;
  protected readonly busy = signal(false);

  protected readonly server = computed<ServerAccess | null>(() => {
    const s = this.view.value()?.supply;
    return s?.spec.kind === 'environment' ? (s.spec.server ?? null) : null;
  });
  protected readonly tier = computed(() => {
    const s = this.view.value()?.supply;
    return s?.spec.kind === 'environment' ? (s.spec.details['tier'] ?? 'staging') : '';
  });
  protected readonly installed = computed(() => this.server()?.apps ?? []);
  protected readonly available = computed(() =>
    (this.view.value()?.catalog ?? []).filter(
      (m) => !this.installed().some((a) => a.app === m.id && a.status !== 'removed'),
    ),
  );
  protected readonly holders = computed(() =>
    (this.units.value() ?? []).filter((u) => u.supplyIds.includes(this.serverId())),
  );
  private readonly credentials = computed(() =>
    (this.supply.value() ?? []).flatMap((s) =>
      s.spec.kind === 'credential' && s.connected ? [s.spec.secretName] : [],
    ),
  );

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const name = this.view.value()?.supply.name;
      if (!name) return;
      crumbs.set([
        ORBAT_CRUMB,
        { label: 'Supply Depot', term: 'supply-depot', link: '/supply' },
        { label: name },
      ]);
      title.set(`${name} · Supply Depot`);
    });
    reloadOnLive(
      (n) =>
        touchedIds(n).includes(this.serverId()) ||
        (n.type === 'version' && n.version.entityType === 'unit'),
      () => {
        this.view.reload();
        this.units.reload();
      },
    );
  }

  protected manifestOf(app: string): AppManifest | null {
    return this.view.value()?.catalog.find((m) => m.id === app) ?? null;
  }

  protected install(manifest: AppManifest, current: ServerApp | null): void {
    const v = this.view.value()!;
    openDialog<SupplyView, InstallAppData, InstallAppDialog>(
      this.dialog,
      InstallAppDialog,
      {
        serverId: v.supply.id,
        serverName: v.supply.name,
        manifest,
        current,
        credentials: this.credentials,
      },
      `Install ${manifest.name}`,
    ).closed.subscribe((s) => {
      if (s) this.view.reload();
    });
  }

  protected edit(): void {
    openDialog<SupplyView, EnvironmentDialogData, EnvironmentDialog>(
      this.dialog,
      EnvironmentDialog,
      { editing: this.view.value()!.supply, credentials: this.credentials },
      `Edit ${this.view.value()!.supply.name}`,
    ).closed.subscribe((s) => {
      if (s) this.view.reload();
    });
  }

  protected check(): Promise<void> {
    const name = this.view.value()!.supply.name;
    return this.act(async () => {
      const r = await this.api.checkServer(this.serverId());
      if (!r.ok) throw new Error(`Could not log in to ${name}: ${r.output || 'no answer'}`);
      return `Logged in to ${name}${r.output ? `: ${r.output}` : ''}.`;
    });
  }

  protected setupWorkspace(): Promise<void> {
    return this.act(async () => {
      await this.api.setupWorkspace(this.serverId());
      return 'Bot workspace set up: bots’ dev work now runs as orbot-dev, without sudo.';
    });
  }

  private async act(fn: () => Promise<string>): Promise<void> {
    this.busy.set(true);
    try {
      this.toasts.show({ tone: 'success', message: await fn() });
      this.view.reload();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
