import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal, type Signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { SupplyView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

export interface ConnectionDialogData {
  repositories: Signal<{ id: string; name: string }[]>;
  credentials: Signal<string[]>;
}

/** Connect GitHub (or GitHub Enterprise) for one of the depot's repositories. */
@Component({
  selector: 'orb-connection-dialog',
  imports: [FormsModule, RouterLink, Term],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Connect GitHub</h2>
      <p class="hint">
        A <orb-term key="connection">connection</orb-term> is the code host, issue tracker and build
        pipeline for one of the depot's repositories. Store the access token as a credential first.
      </p>
      @if (!data.repositories().length) {
        <p class="hint">
          No repositories connected yet.
          <a routerLink="/supply" [queryParams]="{ section: 'repositories' }" (click)="ref.close()"
            >Connect one first</a
          >.
        </p>
      }
      <label for="svc-name">Name</label>
      <input
        id="svc-name"
        name="name"
        class="input"
        required
        [(ngModel)]="name"
        placeholder="GitHub acme/app"
      />
      <label for="svc-repo-supply">For repository</label>
      <select
        id="svc-repo-supply"
        name="repoSupplyId"
        class="input"
        required
        [(ngModel)]="repoSupplyId"
      >
        @for (r of data.repositories(); track r.id) {
          <option [value]="r.id">{{ r.name }}</option>
        }
      </select>
      <div class="pair">
        <div class="field">
          <label for="svc-owner">Owner</label>
          <input id="svc-owner" name="owner" class="input" required [(ngModel)]="owner" />
        </div>
        <div class="field">
          <label for="svc-repo">Repository name</label>
          <input id="svc-repo" name="repo" class="input" required [(ngModel)]="repo" />
        </div>
      </div>
      <label for="svc-push">Push URL <span class="hint">(no token in it)</span></label>
      <input
        id="svc-push"
        name="pushUrl"
        class="input mono"
        required
        [(ngModel)]="pushUrl"
        placeholder="https://github.com/acme/app.git"
      />
      <label for="svc-cred">Token (credential)</label>
      <select id="svc-cred" name="cred" class="input" [(ngModel)]="credentialName">
        <option [ngValue]="null">None</option>
        @for (c of data.credentials(); track c) {
          <option [ngValue]="c">{{ c }}</option>
        }
      </select>
      <label for="svc-api">API URL</label>
      <input id="svc-api" name="apiUrl" class="input mono" required [(ngModel)]="apiUrl" />
      <p class="hint">Change it only for GitHub Enterprise.</p>
      <fieldset class="checks">
        <legend>Use it as</legend>
        <label
          ><input type="checkbox" name="codeHost" [(ngModel)]="codeHost" /> Code host (push, pull
          requests)</label
        >
        <label><input type="checkbox" name="issues" [(ngModel)]="issues" /> Issue tracker</label>
        <label
          ><input type="checkbox" name="pipeline" [(ngModel)]="pipeline" /> Build pipeline (gates
          production deploys)</label
        >
        <label
          ><input type="checkbox" name="closeIssues" [(ngModel)]="closeIssues" /> Close issues when
          their mission is done</label
        >
      </fieldset>
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button
          type="submit"
          class="btn btn--primary"
          [disabled]="busy() || !data.repositories().length"
        >
          Connect GitHub
        </button>
      </div>
    </form>
  `,
  styles: `
    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(calc(var(--space-16) * 3), 1fr));
      gap: var(--space-3);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .checks {
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
      label {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-weight: var(--font-weight-regular);
      }
    }
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class ConnectionDialog {
  protected readonly data = inject<ConnectionDialogData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<SupplyView>>(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected name = '';
  protected apiUrl = 'https://api.github.com';
  protected owner = '';
  protected repo = '';
  protected pushUrl = '';
  protected repoSupplyId = '';
  protected credentialName: string | null = null;
  protected codeHost = true;
  protected issues = true;
  protected pipeline = true;
  protected closeIssues = true;
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const s = await this.api.connectService({
        name: this.name.trim(),
        apiUrl: this.apiUrl.trim(),
        owner: this.owner.trim(),
        repo: this.repo.trim(),
        pushUrl: this.pushUrl.trim(),
        // The list shows the first repository until another is picked.
        repoSupplyId: this.repoSupplyId || this.data.repositories()[0]?.id || '',
        credentialName: this.credentialName,
        services: { codeHost: this.codeHost, issues: this.issues, pipeline: this.pipeline },
        closeIssues: this.closeIssues,
      });
      this.toasts.show({ tone: 'success', message: `Connected ${s.name}.` });
      this.ref.close(s);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
