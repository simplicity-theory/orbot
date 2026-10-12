import { inject, Injectable, signal } from '@angular/core';
import { Api } from './api';

/** Product-level settings served by the API (the product name lives in one config value there). */
@Injectable({ providedIn: 'root' })
export class Meta {
  private readonly api = inject(Api);
  readonly productName = signal('');
  readonly runtime = signal('');
  readonly runtimes = signal<string[]>([]);
  readonly claudeModel = signal('');

  async load(): Promise<void> {
    try {
      const m = await this.api.meta();
      this.productName.set(m.productName);
      this.runtime.set(m.runtime);
      this.runtimes.set(m.runtimes);
      this.claudeModel.set(m.claudeModel);
    } catch {
      // The shell shows the API-unreachable state; keep defaults.
    }
  }
}
