import { Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { SupplyView, UnitView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Can } from '../../ui/can';
import { Icon } from '../../ui/icon';
import { Toasts } from '../../ui/toast';
import { iconOf, tierOf } from './supply-sections';

/** One thing in the depot: what it is, how it is reached, and which units hold it. */
@Component({
  selector: 'orb-supply-item',
  imports: [Can, Icon, RouterLink],
  template: `
    @let s = item();
    <div class="head">
      <orb-icon [name]="icon()" />
      <h3 class="name">
        @if (server()) {
          <a [routerLink]="['/supply/servers', s.id]">{{ s.name }}</a>
        } @else if (s.spec.kind === 'repository') {
          <a [routerLink]="['/supply/repositories', s.id]">{{ s.name }}</a>
        } @else {
          {{ s.name }}
        }
      </h3>
      @if (tier(); as t) {
        <span class="chip" [class.prod]="t === 'production'">{{ t }}</span>
      }
      @if (!s.connected) {
        <span class="chip off">not connected</span>
      }
      @if (server()) {
        <span class="end buttons">
          <button *orbCan="null" type="button" class="btn small" (click)="edit.emit()">Edit</button>
          <a class="btn small" [routerLink]="['/supply/servers', s.id]">Apps & workspace</a>
        </span>
      } @else if (s.spec.kind === 'environment') {
        <button *orbCan="null" type="button" class="btn small end" (click)="edit.emit()">
          Edit
        </button>
      } @else if (s.spec.kind === 'model') {
        <button type="button" class="btn small end" [disabled]="busy()" (click)="checkModel()">
          Check it answers
        </button>
      } @else if (s.spec.kind === 'repository') {
        <a class="btn small end" [routerLink]="['/supply/repositories', s.id]">History & diffs</a>
      }
    </div>

    <dl class="dl facts">
      @switch (s.spec.kind) {
        @case ('repository') {
          <dt>Location</dt>
          <dd class="mono">{{ s.spec.location }}</dd>
          <dt>Default branch</dt>
          <dd class="mono">{{ s.spec.defaultBranch }}</dd>
        }
        @case ('credential') {
          <dt>Secret</dt>
          <dd class="mono">{{ s.spec.secretName }}</dd>
          <dt>Value</dt>
          <dd>Write-only, never shown</dd>
        }
        @case ('connection') {
          <dt>For repository</dt>
          <dd>{{ repoName() ?? 'a repository no longer in the depot' }}</dd>
          <dt>GitHub</dt>
          <dd class="mono">{{ s.spec.owner }}/{{ s.spec.repo }}</dd>
          <dt>Used as</dt>
          <dd>{{ services() }}</dd>
          <dt>Token</dt>
          <dd class="mono">{{ s.spec.credentialName ?? 'none' }}</dd>
        }
        @case ('model') {
          <dt>Model</dt>
          <dd class="mono">{{ s.spec.model }}</dd>
          <dt>API</dt>
          <dd class="mono">{{ s.spec.baseUrl }} <span class="meta">(OpenAI-compatible)</span></dd>
          <dt>API key</dt>
          <dd class="mono">{{ s.spec.credentialName ?? 'none' }}</dd>
          @if (s.spec.contextWindow) {
            <dt>Context</dt>
            <dd>{{ s.spec.contextWindow.toLocaleString() }} tokens</dd>
          }
          @if (s.spec.hostedOn; as h) {
            <dt>Runs on</dt>
            <dd>
              <a [routerLink]="['/supply/servers', h.supplyId]">{{ hostName() ?? 'its server' }}</a>
            </dd>
          }
        }
        @default {
          @if (server(); as sv) {
            <dt>Login</dt>
            <dd class="mono">{{ sv.user }}&#64;{{ sv.host }}:{{ sv.port }}</dd>
            <dt>SSH key</dt>
            <dd class="mono">{{ sv.credentialName }}</dd>
            @if (sv.url) {
              <dt>URL</dt>
              <dd>
                <a [href]="sv.url" target="_blank" rel="noopener">{{ sv.url }}</a>
              </dd>
            }
            @if (sv.facts?.['gpu']; as gpu) {
              <dt>GPU</dt>
              <dd>{{ gpu }}</dd>
            }
            <dt>Apps</dt>
            <dd>{{ apps() || 'none yet' }}</dd>
            @if (tier() === 'dev') {
              <dt>Bots' dev work</dt>
              <dd>
                {{
                  sv.workspace
                    ? 'as ' + sv.workspace.user + ' (no sudo)'
                    : 'as ' + sv.user + ' (set up the bot workspace to keep them apart)'
                }}
              </dd>
            }
          } @else {
            @for (d of details(); track d[0]) {
              <dt>{{ d[0] }}</dt>
              <dd>{{ d[1] }}</dd>
            }
          }
        }
      }
    </dl>

    @if (s.spec.kind === 'connection') {
      <div class="foot">
        <a routerLink="/connections">Open issues and pipelines in Connections</a>
      </div>
    } @else {
      <div class="foot">
        <span class="meta">Issued to</span>
        @for (u of holders(); track u.id) {
          <span class="chip holder">
            <a [routerLink]="['/units', u.id]" [queryParams]="{ section: 'supply' }">{{
              u.name
            }}</a>
            @if (tier() !== 'production') {
              <button
                *orbCan="null"
                type="button"
                class="x"
                [disabled]="busy()"
                [attr.aria-label]="'Withdraw ' + s.name + ' from ' + u.name"
                (click)="allot(u, true)"
              >
                <orb-icon class="sm" name="x" />
              </button>
            }
          </span>
        } @empty {
          <span class="meta">no unit yet</span>
        }
        <div class="issue" *orbCan="null">
          @if (tier() === 'production') {
            <span class="meta"
              >Deploy rights cannot be undone: give them by order in chat, which asks you to
              confirm.</span
            >
          } @else if (others().length) {
            <label class="visually-hidden" [for]="'issue-' + s.id">Issue {{ s.name }} to</label>
            <select class="input" [id]="'issue-' + s.id" #pick>
              @for (u of others(); track u.id) {
                <option [value]="u.id">{{ u.name }}</option>
              }
            </select>
            <button
              type="button"
              class="btn small"
              [disabled]="busy()"
              (click)="allotById(pick.value)"
            >
              Issue
            </button>
          }
        </div>
      </div>
    }
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
    }
    .name {
      font-size: var(--font-size-md);
      font-weight: var(--font-weight-semibold);
      overflow-wrap: anywhere;
    }
    .prod {
      background: color-mix(in srgb, var(--tone-warning) 14%, transparent);
      color: var(--tone-warning);
    }
    .off {
      background: color-mix(in srgb, var(--tone-muted) 14%, transparent);
    }
    .end {
      margin-left: auto;
    }
    .buttons {
      display: inline-flex;
      gap: var(--space-2);
    }
    .facts {
      font-size: var(--font-size-sm);
      dd {
        overflow-wrap: anywhere;
      }
    }
    .foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      padding-top: var(--space-3);
      border-top: var(--border-width) solid var(--color-border);
    }
    .holder {
      padding-right: 0;
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
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin-left: auto;
    }
    .small {
      min-height: auto;
      padding: var(--space-1) var(--space-3);
    }
  `,
})
export class SupplyItem {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly item = input.required<SupplyView>();
  readonly units = input.required<UnitView[]>();
  /** For a connection: the name of the repository it serves. */
  readonly repoName = input<string | null>(null);
  /** For a model: the name of the server it runs on. */
  readonly hostName = input<string | null>(null);
  /** For an environment or server: the Commander wants to change it. */
  readonly edit = output<void>();
  /** Something changed: the page reloads the depot and the units. */
  readonly changed = output<void>();
  protected readonly busy = signal(false);

  protected readonly icon = computed(() => iconOf(this.item()));
  protected readonly tier = computed(() => tierOf(this.item()));
  protected readonly server = computed(() => {
    const s = this.item();
    return s.spec.kind === 'environment' ? (s.spec.server ?? null) : null;
  });
  protected readonly apps = computed(() =>
    (this.server()?.apps ?? [])
      .filter((a) => a.status !== 'removed')
      .map((a) => `${a.name} (${a.status})`)
      .join(', '),
  );
  protected readonly details = computed(() => {
    const spec = this.item().spec;
    if (spec.kind !== 'environment' && spec.kind !== 'tool' && spec.kind !== 'compute') return [];
    return Object.entries(spec.details).filter(([k]) => k !== 'tier');
  });
  protected readonly services = computed(() => {
    const spec = this.item().spec;
    if (spec.kind !== 'connection') return '';
    const used = [
      spec.services.codeHost && 'code host',
      spec.services.issues && 'issue tracker',
      spec.services.pipeline && 'build pipeline',
    ].filter(Boolean);
    return used.length ? used.join(' · ') : 'nothing yet';
  });
  protected readonly holders = computed(() =>
    this.units().filter((u) => u.supplyIds.includes(this.item().id)),
  );
  protected readonly others = computed(() =>
    this.units().filter((u) => !u.supplyIds.includes(this.item().id)),
  );

  protected checkModel(): Promise<void> {
    const s = this.item();
    return this.act(async () => {
      const r = await this.api.checkModel(s.id);
      if (!r.ok) throw new Error(`${s.name}: ${r.message}`);
      return r.message;
    });
  }

  protected allotById(unitId: string): Promise<void> {
    const u = this.units().find((x) => x.id === unitId);
    return u ? this.allot(u, false) : Promise.resolve();
  }

  protected allot(u: UnitView, revoke: boolean): Promise<void> {
    const s = this.item();
    return this.act(
      async () => {
        await this.api.allotSupply(s.id, u.id, revoke);
        return revoke ? `${s.name} withdrawn from ${u.name}.` : `${s.name} issued to ${u.name}.`;
      },
      revoke
        ? undefined
        : async () => {
            await this.api.allotSupply(s.id, u.id, true);
            this.changed.emit();
          },
    );
  }

  private async act(fn: () => Promise<string>, undo?: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      this.toasts.show({ tone: 'success', message: await fn(), ...(undo ? { undo } : {}) });
      this.changed.emit();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
