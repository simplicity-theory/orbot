import { inject, Injectable, signal } from '@angular/core';
import { Api } from './api';

/** Product-level settings served by the API (the product name lives in one config value there). */
@Injectable({ providedIn: 'root' })
export class Meta {
  private readonly api = inject(Api);
  readonly productName = signal('');
  readonly runtime = signal('');

  async load(): Promise<void> {
    try {
      const m = await this.api.meta();
      this.productName.set(m.productName);
      this.runtime.set(m.runtime);
    } catch {
      // The shell shows the API-unreachable state; keep defaults.
    }
  }
}
