import { httpResource } from '@angular/common/http';
import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, apiUrl, type SettingsView } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Toasts } from '../../ui/toast';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { Meta } from '../../core/meta';
import { ThemeService } from '../../core/theme';

@Component({
  selector: 'orb-settings-page',
  imports: [FormsModule],
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1>Settings</h1>
          <p class="page-header__lede">How {{ meta.productName() }} looks and runs.</p>
        </div>
      </header>
      <section class="panel" aria-labelledby="appearance-h">
        <h2 id="appearance-h" class="panel__title">Appearance</h2>
        <fieldset>
          <legend>Theme</legend>
          <label
            ><input
              type="radio"
              name="theme"
              value="dark"
              [checked]="theme.theme() === 'dark'"
              (change)="theme.theme.set('dark')"
            />
            Dark</label
          >
          <label
            ><input
              type="radio"
              name="theme"
              value="light"
              [checked]="theme.theme() === 'light'"
              (change)="theme.theme.set('light')"
            />
            Light</label
          >
        </fieldset>
      </section>
      <section class="panel" aria-labelledby="irrev-h">
        <h2 id="irrev-h" class="panel__title">Orders that need confirmation</h2>
        @if (settings.value(); as st) {
          <form class="form" (ngSubmit)="save(st.version)">
            <p class="hint">
              Chat orders of these kinds cannot be undone, so the Overseer waits for you to type the
              confirmation phrase.
            </p>
            <fieldset class="kinds">
              <legend class="visually-hidden">Action kinds</legend>
              @for (k of st.actionKinds; track k) {
                <label class="mono"
                  ><input type="checkbox" [checked]="chosen().includes(k)" (change)="toggle(k)" />
                  {{ k }}</label
                >
              }
            </fieldset>
            <label for="phrase">Confirmation phrase</label>
            <input id="phrase" name="phrase" class="input" [(ngModel)]="phrase" required />
            <label for="settings-reason">Why the change?</label>
            <input id="settings-reason" name="reason" class="input" [(ngModel)]="reason" required />
            <div class="actions">
              <button
                type="submit"
                class="btn btn--primary"
                [disabled]="busy() || !reason.trim() || !phrase.trim()"
              >
                Save (version {{ st.version + 1 }})
              </button>
            </div>
          </form>
        }
      </section>

      <section class="panel" aria-labelledby="system-h">
        <h2 id="system-h" class="panel__title">System</h2>
        <dl class="dl">
          <dt>Product name</dt>
          <dd>{{ meta.productName() }} <span class="meta">(ORBOT_PRODUCT_NAME)</span></dd>
          <dt>Default bot runtime</dt>
          <dd class="mono">{{ meta.runtime() }}</dd>
          <dt>Runtimes installed</dt>
          <dd>
            <span class="mono">{{ meta.runtimes().join(', ') }}</span>
            @if (!meta.runtimes().includes('claude')) {
              <span class="meta">
                — set ANTHROPIC_API_KEY to enable the Claude runtime ({{
                  meta.claudeModel()
                }}).</span
              >
            }
          </dd>
        </dl>
      </section>
    </div>
  `,
  styles: `
    fieldset {
      display: flex;
      gap: var(--space-4);
      margin: 0;
      padding: 0;
      border: 0;
    }
    legend {
      margin-bottom: var(--space-2);
      color: var(--color-text-muted);
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      cursor: pointer;
    }
    .kinds {
      flex-wrap: wrap;
    }
  `,
})
export class SettingsPage {
  protected readonly theme = inject(ThemeService);
  protected readonly meta = inject(Meta);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly settings = httpResource<SettingsView>(() => apiUrl.settings());
  protected readonly chosen = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected phrase = '';
  protected reason = '';

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Settings' }]);
    effect(() => {
      const st = this.settings.value();
      if (!st) return;
      this.chosen.set(st.irreversibleActions);
      this.phrase = st.confirmationPhrase;
    });
  }

  protected toggle(kind: string): void {
    this.chosen.update((c) => (c.includes(kind) ? c.filter((x) => x !== kind) : [...c, kind]));
  }

  protected async save(version: number): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.updateSettings({
        irreversibleActions: this.chosen(),
        confirmationPhrase: this.phrase.trim(),
        reason: this.reason.trim(),
        expectedVersion: version,
      });
      this.reason = '';
      this.settings.reload();
      this.toasts.show({ tone: 'success', message: 'Settings saved as a new version.' });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
