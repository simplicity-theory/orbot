import { httpResource } from '@angular/common/http';
import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, apiUrl, type SettingsView } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { Meta } from '../../core/meta';
import { ThemeService } from '../../core/theme';

@Component({
  selector: 'orb-settings-page',
  imports: [FormsModule, Term],
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
        <h2 id="irrev-h" class="panel__title">Orders and budgets</h2>
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
            <label for="warn-at">Budget warning at (% of a cap)</label>
            <input
              id="warn-at"
              name="warnAt"
              class="input"
              type="number"
              min="10"
              max="100"
              step="5"
              [(ngModel)]="warnAt"
              required
            />
            <fieldset class="escalation">
              <legend><orb-term key="escalation">Escalation</orb-term> for stuck work</legend>
              <label for="esc-stall">Stall: no progress for (minutes)</label>
              <input
                id="esc-stall"
                name="stall"
                class="input"
                type="number"
                min="1"
                [(ngModel)]="stallMinutes"
              />
              <label for="esc-timeout">Timeout: one run longer than (minutes)</label>
              <input
                id="esc-timeout"
                name="timeout"
                class="input"
                type="number"
                min="1"
                [(ngModel)]="timeoutMinutes"
              />
              <label for="esc-failures">Repeated failures: a task failing (times)</label>
              <input
                id="esc-failures"
                name="failures"
                class="input"
                type="number"
                min="1"
                [(ngModel)]="repeatedFailures"
              />
              <label for="esc-bot">Failing bot: its last runs all failed (runs)</label>
              <input
                id="esc-bot"
                name="botRuns"
                class="input"
                type="number"
                min="2"
                [(ngModel)]="failingBotRuns"
              />
            </fieldset>
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
    .escalation {
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--input-narrow);
      align-items: center;
      gap: var(--space-2) var(--space-3);
      legend {
        grid-column: 1 / -1;
      }
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
  protected warnAt = 80;
  protected stallMinutes = 10;
  protected timeoutMinutes = 60;
  protected repeatedFailures = 2;
  protected failingBotRuns = 3;
  protected reason = '';

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Settings' }]);
    effect(() => {
      const st = this.settings.value();
      if (!st) return;
      this.chosen.set(st.irreversibleActions);
      this.phrase = st.confirmationPhrase;
      this.warnAt = Math.round((st.budgetWarnAt ?? 0.8) * 100);
      const esc = st.escalation;
      if (esc) {
        this.stallMinutes = Math.max(1, Math.round(esc.stallSeconds / 60));
        this.timeoutMinutes = Math.max(1, Math.round(esc.timeoutSeconds / 60));
        this.repeatedFailures = esc.repeatedFailures;
        this.failingBotRuns = esc.failingBotRuns;
      }
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
        budgetWarnAt: Math.min(100, Math.max(10, this.warnAt)) / 100,
        escalation: {
          stallSeconds: Math.max(1, Math.round(this.stallMinutes)) * 60,
          timeoutSeconds: Math.max(1, Math.round(this.timeoutMinutes)) * 60,
          repeatedFailures: Math.max(1, Math.round(this.repeatedFailures)),
          failingBotRuns: Math.max(2, Math.round(this.failingBotRuns)),
        },
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
