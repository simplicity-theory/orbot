import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal, type Signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { SupplyView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Toasts } from '../../ui/toast';

export interface EnvironmentDialogData {
  name?: string;
  /** Names of the stored credentials (SSH keys among them). */
  credentials: Signal<string[]>;
}

type Tier = 'dev' | 'staging' | 'production';

const TIERS: { id: Tier; label: string; hint: string }[] = [
  { id: 'dev', label: 'Dev server', hint: 'Bots build, test and iterate on it.' },
  { id: 'staging', label: 'Staging', hint: 'Where work is tried out before production.' },
  {
    id: 'production',
    label: 'Production',
    hint: 'Issuing it gives deploy rights, which cannot be undone.',
  },
];

/** Add an environment. A dev server, or any server bots log in to over SSH, needs its key. */
@Component({
  selector: 'orb-environment-dialog',
  imports: [FormsModule, RouterLink],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Add a server or environment</h2>
      <label for="env-name">Name</label>
      <input
        id="env-name"
        name="name"
        class="input"
        required
        [(ngModel)]="name"
        placeholder="staging"
      />
      <fieldset class="tiers">
        <legend>Tier</legend>
        @for (t of tiers; track t.id) {
          <label class="tier" [class.on]="tier === t.id">
            <input type="radio" name="tier" [value]="t.id" [(ngModel)]="tier" />
            <span>
              <strong>{{ t.label }}</strong>
              <span class="hint">{{ t.hint }}</span>
            </span>
          </label>
        }
      </fieldset>
      @if (tier !== 'dev') {
        <label class="check"
          ><input type="checkbox" name="isServer" [(ngModel)]="isServer" /> It’s a server bots log
          in to over SSH</label
        >
      }
      @if (asServer()) {
        <div class="server-fields">
          <label for="env-host">Host</label>
          <input
            id="env-host"
            name="host"
            class="input mono"
            required
            [(ngModel)]="host"
            placeholder="203.0.113.10 or app.example.com"
          />
          <label for="env-port">Port</label>
          <input
            id="env-port"
            name="port"
            class="input port"
            type="number"
            min="1"
            max="65535"
            [(ngModel)]="port"
          />
          <label for="env-user">User</label>
          <input
            id="env-user"
            name="user"
            class="input mono"
            required
            [(ngModel)]="user"
            placeholder="deploy"
          />
          <label for="env-key">SSH key (credential)</label>
          <select id="env-key" name="key" class="input" [(ngModel)]="credentialName">
            <option [ngValue]="null" disabled>Choose a stored key</option>
            @for (c of data.credentials(); track c) {
              <option [ngValue]="c">{{ c }}</option>
            }
          </select>
          <label for="env-url">URL <span class="hint">(optional)</span></label>
          <input
            id="env-url"
            name="url"
            class="input"
            [(ngModel)]="url"
            placeholder="https://staging.example.com"
          />
        </div>
        @if (!data.credentials().length) {
          <p class="hint">
            No credentials stored yet.
            <a routerLink="/supply" [queryParams]="{ section: 'credentials' }" (click)="ref.close()"
              >Store the private key first</a
            >
            as a several-lines credential (no passphrase).
          </p>
        }
        <p class="hint">
          @if (tier === 'dev') {
            Each bot gets its own folder (<span class="mono"
              >~/orbot-dev/&lt;repo&gt;/&lt;bot&gt;</span
            >) kept in step with its code. Install rsync for fast syncs.
          }
          ORBOT pins the host key and tests the login when you connect. Every command is on the
          record. Bots use <span class="mono">sudo -n</span>, so give the user passwordless sudo if
          they should install packages.
        </p>
      }
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button
          type="submit"
          class="btn btn--primary"
          [disabled]="busy() || !name.trim() || (asServer() && !credentialName)"
        >
          {{ asServer() ? 'Connect server' : 'Connect environment' }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .tiers {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      border: 0;
      legend {
        margin-bottom: var(--space-2);
        font-weight: var(--font-weight-medium);
      }
    }
    .tier {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      padding: var(--space-2) var(--space-3);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      font-weight: var(--font-weight-regular);
      cursor: pointer;
      > span {
        display: flex;
        flex-direction: column;
      }
      input {
        margin-top: var(--space-1);
      }
      &.on {
        border-color: var(--color-accent);
      }
    }
    .check {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      font-weight: var(--font-weight-regular);
    }
    .server-fields {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--space-2) var(--space-3);
      align-items: center;
    }
    .port {
      max-width: calc(var(--space-16) * 2);
    }
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class EnvironmentDialog {
  protected readonly data = inject<EnvironmentDialogData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<SupplyView>>(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly tiers = TIERS;
  protected name = this.data.name ?? '';
  protected tier: Tier = 'staging';
  protected isServer = false;
  protected host = '';
  protected port = 22;
  protected user = '';
  protected credentialName: string | null = null;
  protected url = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  /** A dev environment is always a server. */
  protected asServer(): boolean {
    return this.tier === 'dev' || this.isServer;
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      let message: string;
      let s: SupplyView;
      if (this.asServer()) {
        s = await this.api.connectServer({
          name: this.name.trim(),
          tier: this.tier,
          host: this.host.trim(),
          port: Number(this.port) || 22,
          user: this.user.trim(),
          credentialName: this.credentialName ?? '',
          url: this.url.trim() || null,
        });
        message = `Connected server ${s.name}: logged in, host key pinned.`;
      } else {
        s = await this.api.connectEnvironment(
          this.name.trim(),
          this.tier as 'staging' | 'production',
        );
        message = `Connected environment ${s.name}.`;
      }
      this.toasts.show({ tone: 'success', message });
      this.ref.close(s);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
