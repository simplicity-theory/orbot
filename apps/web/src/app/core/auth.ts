import { inject, Injectable, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import type { Principal } from '@orbot/shared';
import { Api } from './api';

/** The signed-in principal. `undefined` while checking, `null` when signed out. */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly api = inject(Api);
  readonly principal = signal<Principal | null | undefined>(undefined);

  async check(): Promise<Principal | null> {
    try {
      const { principal } = await this.api.me();
      this.principal.set(principal);
      return principal;
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        this.principal.set(null);
        return null;
      }
      throw err;
    }
  }

  async login(passphrase: string): Promise<void> {
    const { principal } = await this.api.login(passphrase);
    this.principal.set(principal);
  }

  async logout(): Promise<void> {
    await this.api.logout();
    this.principal.set(null);
  }
}
