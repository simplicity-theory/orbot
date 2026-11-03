import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SupplyView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';

export interface GitHubData {
  theatreId: string;
  name: string;
}

/**
 * Put a theatre's repository on GitHub: the repository is made there if there is none by that
 * name, main is pushed now, and every landing after. The token is stored as a credential and
 * used by name; it goes in no record.
 */
@Component({
  selector: 'orb-github-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Put Theatre {{ data.name }} on GitHub</h2>
      <p class="hint">
        ORBOT creates the repository under your user or organisation if it is not there yet, pushes
        main now, and pushes every landing from then on. Pull requests, issues and the build
        pipeline connect with it.
      </p>
      <label for="gh-owner">GitHub user or organisation</label>
      <input
        id="gh-owner"
        name="owner"
        class="input"
        required
        maxlength="100"
        [(ngModel)]="owner"
        placeholder="octocat"
      />
      <label for="gh-repo">Repository name</label>
      <input
        id="gh-repo"
        name="repo"
        class="input"
        maxlength="100"
        pattern="[A-Za-z0-9._-]+"
        [(ngModel)]="repo"
        [placeholder]="slug()"
      />
      <fieldset class="choice">
        <legend>Token</legend>
        @if (credentials().length) {
          <label for="gh-cred">A token already in the Supply Depot</label>
          <select id="gh-cred" name="credential" class="input" [(ngModel)]="credentialName">
            <option value="">Paste a new one below</option>
            @for (c of credentials(); track c.id) {
              <option [value]="c.name">{{ c.name }}</option>
            }
          </select>
        }
        @if (!credentialName) {
          <label for="gh-token">Personal access token <span class="hint">(repo scope)</span></label>
          <input
            id="gh-token"
            name="token"
            type="password"
            class="input"
            autocomplete="off"
            maxlength="500"
            [(ngModel)]="token"
          />
          <p class="hint">
            Stored as a credential named token-github-{{ ownerSlug() }} and used by name; it goes in
            no record.
          </p>
        }
      </fieldset>
      <label class="check"
        ><input type="checkbox" name="private" [(ngModel)]="private" /> Private repository</label
      >
      <details>
        <summary>GitHub Enterprise</summary>
        <label for="gh-api">API URL</label>
        <input id="gh-api" name="apiUrl" class="input" type="url" [(ngModel)]="apiUrl" />
      </details>
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Not now</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy() || !valid()">
          Put it on GitHub
        </button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
    .choice {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    summary {
      padding: var(--space-2) 0;
      cursor: pointer;
    }
  `,
})
export class GitHubDialog {
  protected readonly data = inject<GitHubData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly depot = httpResource<SupplyView[]>(() => apiUrl.supply());
  protected readonly credentials = computed(() =>
    (this.depot.value() ?? []).filter((s) => s.spec.kind === 'credential' && s.connected),
  );
  protected apiUrl = 'https://api.github.com';
  protected owner = '';
  protected repo = '';
  protected credentialName = '';
  protected token = '';
  protected private = true;
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected slug(): string {
    return (
      this.data.name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'project'
    );
  }

  protected ownerSlug(): string {
    return (
      this.owner
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-') || '<owner>'
    );
  }

  protected valid(): boolean {
    return !!this.owner.trim() && (!!this.credentialName || !!this.token.trim());
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const v = await this.api.putTheatreOnGitHub(this.data.theatreId, {
        apiUrl: this.apiUrl.trim() || 'https://api.github.com',
        owner: this.owner.trim(),
        repo: this.repo.trim() || null,
        credentialName: this.credentialName || null,
        token: this.credentialName ? null : this.token.trim(),
        private: this.private,
      });
      this.token = '';
      this.ref.close(v.github?.url ?? true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
