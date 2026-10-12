import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Auth } from '../../core/auth';
import { Live } from '../../core/live';
import { Meta } from '../../core/meta';

@Component({
  selector: 'orb-login-page',
  imports: [FormsModule],
  template: `
    <main class="wrap">
      <form class="panel" (ngSubmit)="submit()">
        <p class="eyebrow">{{ meta.productName() }}</p>
        <h1>Sign in, Commander</h1>
        <label for="passphrase">Passphrase</label>
        <input
          id="passphrase"
          name="passphrase"
          class="input"
          type="password"
          autocomplete="current-password"
          required
          [(ngModel)]="passphrase"
          [attr.aria-invalid]="!!error()"
          [attr.aria-describedby]="error() ? 'login-error' : 'login-hint'"
        />
        <p id="login-hint" class="meta">
          Set by <code>ORBOT_COMMANDER_PASSPHRASE</code> in your <code>.env</code>.
        </p>
        @if (error(); as e) {
          <p id="login-error" class="error" role="alert">{{ e.message }} {{ e.action }}</p>
        }
        <button class="btn btn--primary" type="submit" [disabled]="busy()">
          {{ busy() ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </main>
  `,
  styles: `
    .wrap {
      display: grid;
      place-items: center;
      min-height: var(--viewport-height);
      padding: var(--space-6);
    }
    form {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      width: 100%;
      max-width: var(--measure);
      padding: var(--space-8);
    }
    .eyebrow {
      color: var(--color-accent);
      font-weight: var(--font-weight-bold);
      letter-spacing: var(--letter-spacing-caps);
    }
    h1 {
      margin-bottom: var(--space-3);
    }
    label {
      font-weight: var(--font-weight-medium);
    }
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class LoginPage {
  protected readonly meta = inject(Meta);
  private readonly auth = inject(Auth);
  private readonly live = inject(Live);
  private readonly router = inject(Router);
  readonly returnUrl = input<string>('/');

  protected passphrase = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.login(this.passphrase);
      this.live.connect();
      await this.router.navigateByUrl(this.returnUrl() || '/');
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
