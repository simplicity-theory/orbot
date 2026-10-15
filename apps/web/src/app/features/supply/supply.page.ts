import { Can } from '../../ui/can';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { SupplyView, UnitView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

type Form = 'repository' | 'credential' | 'environment' | 'service';

/** Only what the Commander has connected exists. Connect it here, then issue it to units. */
@Component({
  selector: 'orb-supply-page',
  imports: [Can, FormsModule, RouterLink, EmptyState, Icon, LoadError, Skeleton, Term],
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1><orb-term key="supply-depot">Supply Depot</orb-term></h1>
          <p class="page-header__lede">
            Repositories, environments and credential references you have connected. Units can only
            use what is issued to them.
          </p>
        </div>
      </header>

      @if (connect(); as wanted) {
        <p class="panel notice" role="status">
          <orb-icon name="info" />
          <span
            >An Overseer asked for <strong>{{ wanted }}</strong
            >, which is not connected yet. Connect it below, then issue it in chat or here.</span
          >
        </p>
      }

      <section *orbCan="null" class="panel" aria-labelledby="connect-h">
        <h2 id="connect-h" class="panel__title">Connect</h2>
        <div class="tabs" role="group" aria-label="What to connect">
          @for (f of forms; track f) {
            <button
              type="button"
              class="btn btn--ghost"
              [attr.aria-pressed]="form() === f"
              (click)="form.set(f)"
            >
              {{ f }}
            </button>
          }
        </div>
        @switch (form()) {
          @case ('repository') {
            <form class="form" (ngSubmit)="connectRepo()">
              <label for="repo-name">Name</label>
              <input
                id="repo-name"
                name="name"
                class="input"
                required
                [(ngModel)]="repo.name"
                placeholder="payments-service"
              />
              <label for="repo-loc">Local path or clone URL</label>
              <input
                id="repo-loc"
                name="location"
                class="input"
                required
                [(ngModel)]="repo.location"
                placeholder="/home/me/src/payments-service"
              />
              <p class="hint">
                Never put a token in the URL: store it as a credential and refer to it by name.
              </p>
              <div class="actions">
                <button type="submit" class="btn btn--primary" [disabled]="busy()">
                  Connect repository
                </button>
              </div>
            </form>
          }
          @case ('credential') {
            <form class="form" (ngSubmit)="storeCredential()">
              <label for="cred-name">Name</label>
              <input
                id="cred-name"
                name="name"
                class="input"
                required
                [(ngModel)]="cred.name"
                placeholder="payments-deploy-token"
              />
              <label class="check"
                ><input type="checkbox" name="multiline" [(ngModel)]="cred.multiline" /> It’s
                several lines (an SSH private key)</label
              >
              <label for="cred-value">Value</label>
              @if (cred.multiline) {
                <textarea
                  id="cred-value"
                  name="value"
                  class="input mono key"
                  rows="6"
                  autocomplete="off"
                  spellcheck="false"
                  required
                  [(ngModel)]="cred.value"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                ></textarea>
              } @else {
                <input
                  id="cred-value"
                  name="value"
                  class="input"
                  type="password"
                  autocomplete="off"
                  required
                  [(ngModel)]="cred.value"
                />
              }
              <p class="hint">
                Write-only. The value goes to the encrypted secrets store and is never shown again;
                everything else refers to it by name.
              </p>
              <div class="actions">
                <button type="submit" class="btn btn--primary" [disabled]="busy()">
                  Store credential
                </button>
              </div>
            </form>
          }
          @case ('service') {
            <form class="form" (ngSubmit)="connectService()">
              <p class="hint">
                <orb-term key="connection">Connect</orb-term> GitHub (or GitHub Enterprise) for one
                of the depot's repositories: its code host, issue tracker and build pipeline. Store
                the access token as a credential first.
              </p>
              <label for="svc-name">Name</label>
              <input
                id="svc-name"
                name="name"
                class="input"
                required
                [(ngModel)]="svc.name"
                placeholder="GitHub acme/app"
              />
              <label for="svc-repo-supply">For repository</label>
              <select
                id="svc-repo-supply"
                name="repoSupplyId"
                class="input"
                required
                [(ngModel)]="svc.repoSupplyId"
              >
                @for (r of repositories(); track r.id) {
                  <option [value]="r.id">{{ r.name }}</option>
                }
              </select>
              <label for="svc-api">API URL</label>
              <input id="svc-api" name="apiUrl" class="input" required [(ngModel)]="svc.apiUrl" />
              <label for="svc-owner">Owner</label>
              <input id="svc-owner" name="owner" class="input" required [(ngModel)]="svc.owner" />
              <label for="svc-repo">Repository name</label>
              <input id="svc-repo" name="repo" class="input" required [(ngModel)]="svc.repo" />
              <label for="svc-push">Push URL <span class="hint">(no token in it)</span></label>
              <input
                id="svc-push"
                name="pushUrl"
                class="input"
                required
                [(ngModel)]="svc.pushUrl"
                placeholder="https://github.com/acme/app.git"
              />
              <label for="svc-cred">Token (credential)</label>
              <select id="svc-cred" name="cred" class="input" [(ngModel)]="svc.credentialName">
                <option [ngValue]="null">None</option>
                @for (c of credentials(); track c) {
                  <option [ngValue]="c">{{ c }}</option>
                }
              </select>
              <div class="checks" role="group" aria-label="Use it as">
                <label
                  ><input type="checkbox" name="codeHost" [(ngModel)]="svc.codeHost" /> Code host
                  (push, pull requests)</label
                >
                <label
                  ><input type="checkbox" name="issues" [(ngModel)]="svc.issues" /> Issue
                  tracker</label
                >
                <label
                  ><input type="checkbox" name="pipeline" [(ngModel)]="svc.pipeline" /> Build
                  pipeline (gates production deploys)</label
                >
                <label
                  ><input type="checkbox" name="closeIssues" [(ngModel)]="svc.closeIssues" /> Close
                  issues when their mission is done</label
                >
              </div>
              <div class="actions">
                <button type="submit" class="btn btn--primary" [disabled]="busy()">
                  Connect service
                </button>
              </div>
            </form>
          }
          @case ('environment') {
            <form class="form" (ngSubmit)="connectEnv()">
              <label for="env-name">Name</label>
              <input
                id="env-name"
                name="name"
                class="input"
                required
                [(ngModel)]="env.name"
                placeholder="staging"
              />
              <label for="env-tier">Tier</label>
              <select id="env-tier" name="tier" class="input" [(ngModel)]="env.tier">
                <option value="dev">dev (a server bots build and test on)</option>
                <option value="staging">staging</option>
                <option value="production">
                  production (issuing it = deploy rights; cannot be undone)
                </option>
              </select>
              @if (env.tier !== 'dev') {
                <label class="check"
                  ><input type="checkbox" name="isServer" [(ngModel)]="env.isServer" /> It’s a
                  server bots log in to over SSH</label
                >
              }
              @if (env.isServer || env.tier === 'dev') {
                <div class="server-fields">
                  <label for="env-host">Host</label>
                  <input
                    id="env-host"
                    name="host"
                    class="input"
                    required
                    [(ngModel)]="env.host"
                    placeholder="203.0.113.10 or app.example.com"
                  />
                  <label for="env-port">Port</label>
                  <input
                    id="env-port"
                    name="port"
                    class="input"
                    type="number"
                    min="1"
                    max="65535"
                    [(ngModel)]="env.port"
                  />
                  <label for="env-user">User</label>
                  <input
                    id="env-user"
                    name="user"
                    class="input"
                    required
                    [(ngModel)]="env.user"
                    placeholder="deploy"
                  />
                  <label for="env-key">SSH key (credential)</label>
                  <select id="env-key" name="key" class="input" [(ngModel)]="env.credentialName">
                    <option [ngValue]="null" disabled>Choose a stored key</option>
                    @for (c of credentials(); track c) {
                      <option [ngValue]="c">{{ c }}</option>
                    }
                  </select>
                  <label for="env-url">URL <span class="hint">(optional)</span></label>
                  <input
                    id="env-url"
                    name="url"
                    class="input"
                    [(ngModel)]="env.url"
                    placeholder="https://staging.example.com"
                  />
                </div>
                <p class="hint">
                  @if (env.tier === 'dev') {
                    Bots in the units you issue it to get their own folder on it (<span class="mono"
                      >~/orbot-dev/&lt;repo&gt;/&lt;bot&gt;</span
                    >), kept in step with their code, and run whatever they need there to build,
                    test and iterate. Install rsync on it for fast syncs.
                  }
                  Store the private key first as a multi-line credential (no passphrase). ORBOT pins
                  the server’s host key and tests the login when you connect. Units you issue the
                  server to may log in and set it up as their work needs; every command is on the
                  record. Production servers are reached only inside a deploy you approve.
                </p>
              }
              <div class="actions">
                <button
                  type="submit"
                  class="btn btn--primary"
                  [disabled]="
                    busy() || ((env.isServer || env.tier === 'dev') && !env.credentialName)
                  "
                >
                  {{
                    env.isServer || env.tier === 'dev' ? 'Connect server' : 'Connect environment'
                  }}
                </button>
              </div>
            </form>
          }
        }
      </section>

      @if (supply.error(); as err) {
        <orb-load-error [error]="err" (retry)="supply.reload()" />
      } @else if (supply.hasValue()) {
        <section aria-labelledby="stock-h">
          <h2 id="stock-h" class="panel__title">In the depot</h2>
          <ul class="list-reset stock">
            @for (s of supply.value(); track s.id) {
              <li class="panel">
                <div class="row">
                  <orb-icon [name]="icon(s)" />
                  <strong>{{ s.name }}</strong>
                  <span class="chip">{{ s.spec.kind }}{{ tier(s) ? ' · ' + tier(s) : '' }}</span>
                  <span class="meta">{{ s.connected ? 'connected' : 'not connected' }}</span>
                </div>
                @if (server(s); as sv) {
                  <div class="row server">
                    <span class="mono">{{ sv.user }}&#64;{{ sv.host }}:{{ sv.port }}</span>
                    <span class="meta">key {{ sv.credentialName }}</span>
                    @if (sv.url) {
                      <a [href]="sv.url" target="_blank" rel="noopener">{{ sv.url }}</a>
                    }
                    <button
                      type="button"
                      class="btn small"
                      *orbCan="null"
                      [disabled]="busy()"
                      (click)="checkServer(s)"
                    >
                      Check login
                    </button>
                  </div>
                  @for (f of sv.fingerprints; track f) {
                    <div class="meta mono fingerprint">{{ f }}</div>
                  }
                }
                <div class="row holders" [hidden]="s.spec.kind === 'connection'">
                  <span class="meta">Issued to:</span>
                  @for (u of holders(s.id); track u.id) {
                    <span class="chip">
                      <a [routerLink]="['/units', u.id]" [queryParams]="{ section: 'supply' }">{{
                        u.name
                      }}</a>
                      @if (!(s.spec.kind === 'environment' && tier(s) === 'production')) {
                        <button
                          type="button"
                          class="x"
                          [attr.aria-label]="'Withdraw ' + s.name + ' from ' + u.name"
                          (click)="allot(s, u, true)"
                        >
                          <orb-icon class="sm" name="x" />
                        </button>
                      }
                    </span>
                  } @empty {
                    <span class="meta">nobody</span>
                  }
                  @if (s.spec.kind === 'environment' && tier(s) === 'production') {
                    <span class="meta issue"
                      >Deploy rights cannot be undone: give them by order in chat, which asks you to
                      confirm.</span
                    >
                  } @else {
                    <label class="visually-hidden" [for]="'issue-' + s.id"
                      >Issue {{ s.name }} to</label
                    >
                    <select class="input issue" [id]="'issue-' + s.id" #pick>
                      @for (u of others(s.id); track u.id) {
                        <option [value]="u.id">{{ u.name }}</option>
                      }
                    </select>
                    <button
                      type="button"
                      class="btn small"
                      [disabled]="busy() || !others(s.id).length"
                      (click)="allotById(s, pick.value)"
                    >
                      Issue
                    </button>
                  }
                </div>
              </li>
            } @empty {
              <orb-empty-state icon="key" title="Nothing connected yet"
                >Connect a repository, an environment or a credential above.</orb-empty-state
              >
            }
          </ul>
        </section>
      } @else {
        <orb-skeleton variant="block" [lines]="3" />
      }
    </div>
  `,
  styles: `
    .checks {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      label {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
      }
    }
    .notice {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      border-color: var(--tone-warning);
    }
    .tabs {
      display: flex;
      gap: var(--space-1);
      margin-bottom: var(--space-3);
      text-transform: capitalize;
      [aria-pressed='true'] {
        background: var(--color-surface-3);
        color: var(--color-text);
      }
    }
    .check {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
    }
    .key {
      resize: vertical;
      font-family: var(--font-mono);
    }
    .server-fields {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--space-2) var(--space-3);
      align-items: center;
    }
    .fingerprint {
      overflow-wrap: anywhere;
    }
    .stock {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }
    .holders {
      margin-top: var(--space-2);
    }
    .x {
      display: inline-flex;
      min-width: var(--space-6);
      min-height: var(--space-6);
      align-items: center;
      justify-content: center;
      border: 0;
      background: none;
      color: inherit;
      cursor: pointer;
    }
    .issue {
      margin-left: auto;
    }
    .small {
      min-height: auto;
      padding: var(--space-1) var(--space-3);
    }
  `,
})
export class SupplyPage implements OnInit {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  /** `?connect=` — what an Overseer said was missing. */
  readonly connect = input<string>();
  protected readonly supply = httpResource<SupplyView[]>(() => apiUrl.supply());
  private readonly unitList = httpResource<UnitView[]>(() => apiUrl.units());
  protected readonly units = computed(() => this.unitList.value() ?? []);
  protected readonly forms: Form[] = ['repository', 'credential', 'environment', 'service'];
  protected readonly form = signal<Form>('repository');
  protected readonly busy = signal(false);
  protected repo = { name: '', location: '' };
  protected cred = { name: '', value: '', multiline: false };
  protected env = this.blankEnv();
  protected svc = {
    name: '',
    apiUrl: 'https://api.github.com',
    owner: '',
    repo: '',
    pushUrl: '',
    repoSupplyId: '',
    credentialName: null as string | null,
    codeHost: true,
    issues: true,
    pipeline: true,
    closeIssues: true,
  };
  protected readonly repositories = computed(() =>
    (this.supply.value() ?? []).filter((s) => s.spec.kind === 'repository' && s.connected),
  );
  protected readonly credentials = computed(() =>
    (this.supply.value() ?? []).flatMap((s) =>
      s.spec.kind === 'credential' && s.connected ? [s.spec.secretName] : [],
    ),
  );

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Supply Depot', term: 'supply-depot' }]);
    reloadOnLive(
      (n) =>
        n.type === 'version' &&
        (n.version.entityType === 'supply' || n.version.entityType === 'unit'),
      () => {
        this.supply.reload();
        this.unitList.reload();
      },
    );
  }

  ngOnInit(): void {
    const wanted = this.connect();
    if (!wanted) return;
    const kind = /environment/i.test(wanted)
      ? 'environment'
      : /credential|token/i.test(wanted)
        ? 'credential'
        : 'repository';
    this.form.set(kind);
    const name = wanted.replace(/\b(repository|environment|credential)\b/gi, '').trim();
    if (kind === 'repository') this.repo.name = name;
    else if (kind === 'credential') this.cred.name = name;
    else this.env.name = name;
  }

  protected icon(s: SupplyView) {
    return s.spec.kind === 'repository'
      ? 'git-branch'
      : s.spec.kind === 'credential'
        ? 'key'
        : s.spec.kind === 'connection'
          ? 'link'
          : 'coins';
  }

  private blankEnv() {
    return {
      name: '',
      tier: 'staging' as 'dev' | 'staging' | 'production',
      isServer: false,
      host: '',
      port: 22,
      user: '',
      credentialName: null as string | null,
      url: '',
    };
  }

  protected server(s: SupplyView) {
    return s.spec.kind === 'environment' ? (s.spec.server ?? null) : null;
  }

  protected checkServer(s: SupplyView): Promise<void> {
    return this.act(async () => {
      const r = await this.api.checkServer(s.id);
      if (!r.ok) throw new Error(`Could not log in to ${s.name}: ${r.output || 'no answer'}`);
      return `Logged in to ${s.name}: ${r.output}`;
    });
  }

  protected tier(s: SupplyView): string | null {
    return s.spec.kind === 'environment' ? (s.spec.details['tier'] ?? null) : null;
  }

  protected holders(id: string): UnitView[] {
    return this.units().filter((u) => u.supplyIds.includes(id));
  }

  protected others(id: string): UnitView[] {
    return this.units().filter((u) => !u.supplyIds.includes(id));
  }

  protected connectRepo(): Promise<void> {
    return this.act(async () => {
      const s = await this.api.connectRepository(this.repo.name.trim(), this.repo.location.trim());
      this.repo = { name: '', location: '' };
      return `Connected ${s.name}.`;
    });
  }

  protected storeCredential(): Promise<void> {
    return this.act(async () => {
      const s = await this.api.storeCredential(this.cred.name.trim(), this.cred.value);
      this.cred = { name: '', value: '', multiline: false };
      return `Stored credential ${s.name} (value is write-only).`;
    });
  }

  protected connectEnv(): Promise<void> {
    return this.act(async () => {
      const e = this.env;
      if (e.isServer || e.tier === 'dev') {
        const s = await this.api.connectServer({
          name: e.name.trim(),
          tier: e.tier,
          host: e.host.trim(),
          port: Number(e.port) || 22,
          user: e.user.trim(),
          credentialName: e.credentialName ?? '',
          url: e.url.trim() || null,
        });
        this.env = this.blankEnv();
        return `Connected server ${s.name}: logged in, host key pinned.`;
      }
      const s = await this.api.connectEnvironment(e.name.trim(), e.tier);
      this.env = this.blankEnv();
      return `Connected environment ${s.name}.`;
    });
  }

  protected connectService(): Promise<void> {
    return this.act(async () => {
      const v = this.svc;
      const s = await this.api.connectService({
        name: v.name.trim(),
        apiUrl: v.apiUrl.trim(),
        owner: v.owner.trim(),
        repo: v.repo.trim(),
        pushUrl: v.pushUrl.trim(),
        // The list shows the first repository until another is picked.
        repoSupplyId: v.repoSupplyId || this.repositories()[0]?.id || '',
        credentialName: v.credentialName,
        services: { codeHost: v.codeHost, issues: v.issues, pipeline: v.pipeline },
        closeIssues: v.closeIssues,
      });
      return `Connected ${s.name}.`;
    });
  }

  protected allotById(s: SupplyView, unitId: string): Promise<void> {
    const u = this.units().find((x) => x.id === unitId);
    return u ? this.allot(s, u, false) : Promise.resolve();
  }

  protected allot(s: SupplyView, u: UnitView, revoke: boolean): Promise<void> {
    return this.act(
      async () => {
        await this.api.allotSupply(s.id, u.id, revoke);
        this.unitList.reload();
        return revoke ? `${s.name} withdrawn from ${u.name}.` : `${s.name} issued to ${u.name}.`;
      },
      revoke
        ? undefined
        : async () => {
            await this.api.allotSupply(s.id, u.id, true);
            this.unitList.reload();
          },
    );
  }

  private async act(fn: () => Promise<string>, undo?: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      this.toasts.show({ tone: 'success', message: await fn(), ...(undo ? { undo } : {}) });
      this.supply.reload();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
