import { Auth } from '../../core/auth';
import { Can } from '../../ui/can';
import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AlertKind, RecordEvent } from '@orbot/shared';
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
  imports: [Can, FormsModule, Term, RouterLink],
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
            <label class="check"
              ><input type="checkbox" name="yield" [(ngModel)]="mainEffortYield" />
              Running work an Overseer started pauses (with a handover) to free a bot for the
              <orb-term key="main-effort">main effort</orb-term></label
            >
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
            <fieldset class="stack">
              <legend><orb-term key="daily-brief">Daily brief</orb-term></legend>
              <label class="check"
                ><input type="checkbox" name="briefOn" [(ngModel)]="briefEnabled" /> HQ writes one
                every day</label
              >
              <div class="pairs">
                <label for="brief-at">At (local time)</label>
                <input
                  id="brief-at"
                  name="briefAt"
                  class="input"
                  type="time"
                  [(ngModel)]="briefAt"
                />
                <label for="brief-tz">Time zone</label>
                <input
                  id="brief-tz"
                  name="briefTz"
                  class="input"
                  [(ngModel)]="briefTimeZone"
                  placeholder="Europe/London"
                />
              </div>
            </fieldset>
            <fieldset class="stack">
              <legend>Phone alerts</legend>
              <p class="hint">
                Install the ntfy app (or any service that takes an HTTP POST), subscribe to a
                private topic, and store its URL as a credential in the
                <a routerLink="/supply">Supply Depot</a>. The URL stays in the secrets store.
              </p>
              <label class="check"
                ><input type="checkbox" name="alertsOn" [(ngModel)]="alertsEnabled" /> Alert my
                phone when something needs me</label
              >
              <label for="alert-cred">Push URL (credential)</label>
              <select id="alert-cred" name="alertCred" class="input" [(ngModel)]="alertCredential">
                <option [ngValue]="null">None</option>
                @for (c of credentials(); track c) {
                  <option [ngValue]="c">{{ c }}</option>
                }
              </select>
              <div class="alert-kinds" role="group" aria-label="Alert me about">
                @for (k of alertKinds; track k.id) {
                  <label
                    ><input
                      type="checkbox"
                      [checked]="alertsFor().includes(k.id)"
                      (change)="toggleAlert(k.id)"
                    />
                    {{ k.label }}</label
                  >
                }
              </div>
              <div>
                <button
                  *orbCan="null"
                  type="button"
                  class="btn"
                  [disabled]="busy() || !st.alerts.credentialName"
                  (click)="testAlert()"
                >
                  Send a test alert
                </button>
              </div>
              @if (recentAlerts.value()?.length) {
                <ul class="list-reset alerts" aria-label="Recent alerts">
                  @for (a of recentAlerts.value(); track a.id) {
                    <li>
                      <span [class.failed]="!a.body.delivered">{{
                        a.body.delivered ? 'Delivered' : 'Not delivered'
                      }}</span>
                      {{ a.body.title }}
                      @if (a.body.error) {
                        <span class="meta">— {{ a.body.error }}</span>
                      }
                    </li>
                  }
                </ul>
              }
            </fieldset>
            <label for="settings-reason">Why the change?</label>
            <input id="settings-reason" name="reason" class="input" [(ngModel)]="reason" required />
            @if (!auth.isCommander()) {
              <p class="hint">Only a Commander changes settings.</p>
            }
            <div class="actions" *orbCan="null">
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
    .stack {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-3);
    }
    .pairs {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-2) var(--space-3);
    }
    .alert-kinds {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3) var(--space-5);
    }
    .alerts {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      font-size: var(--font-size-sm);
      .failed {
        color: var(--tone-danger);
      }
    }
    .hint a {
      text-decoration: underline;
    }
    .check {
      display: flex;
      gap: var(--space-2);
      align-items: baseline;
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
  protected readonly auth = inject(Auth);
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
  protected mainEffortYield = true;
  protected briefEnabled = true;
  protected briefAt = '07:00';
  protected briefTimeZone = 'UTC';
  protected alertsEnabled = false;
  protected alertCredential: string | null = null;
  protected readonly alertsFor = signal<AlertKind[]>([]);
  protected readonly alertKinds: { id: AlertKind; label: string }[] = [
    { id: 'escalation', label: 'Escalations' },
    { id: 'approval', label: 'Plans to approve' },
    { id: 'deploy', label: 'Production deploys' },
    { id: 'dispute', label: 'Disputes to rule on' },
    { id: 'budget', label: 'Work held at a budget cap' },
    { id: 'sand-table', label: 'Sand table no-go' },
    { id: 'daily-brief', label: 'Daily brief ready' },
  ];
  private readonly secrets = httpResource<{ name: string; revoked: boolean }[]>(() =>
    apiUrl.secrets(),
  );
  protected readonly credentials = computed(() =>
    (this.secrets.value() ?? []).filter((s) => !s.revoked).map((s) => s.name),
  );
  protected readonly recentAlerts = httpResource<RecordEvent<'alert.sent'>[]>(() =>
    apiUrl.alerts(),
  );
  protected reason = '';

  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Settings' }]);
    effect(() => {
      const st = this.settings.value();
      if (!st) return;
      this.chosen.set(st.irreversibleActions);
      this.phrase = st.confirmationPhrase;
      this.warnAt = Math.round((st.budgetWarnAt ?? 0.8) * 100);
      this.mainEffortYield = st.mainEffortYield ?? true;
      this.briefEnabled = st.dailyBrief?.enabled ?? true;
      this.briefAt = st.dailyBrief?.at ?? '07:00';
      this.briefTimeZone =
        st.dailyBrief?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      this.alertsEnabled = st.alerts?.enabled ?? false;
      this.alertCredential = st.alerts?.credentialName ?? null;
      this.alertsFor.set(st.alerts?.kinds ?? []);
      const esc = st.escalation;
      if (esc) {
        this.stallMinutes = Math.max(1, Math.round(esc.stallSeconds / 60));
        this.timeoutMinutes = Math.max(1, Math.round(esc.timeoutSeconds / 60));
        this.repeatedFailures = esc.repeatedFailures;
        this.failingBotRuns = esc.failingBotRuns;
      }
    });
  }

  protected toggleAlert(kind: AlertKind): void {
    this.alertsFor.update((c) => (c.includes(kind) ? c.filter((x) => x !== kind) : [...c, kind]));
  }

  protected async testAlert(): Promise<void> {
    this.busy.set(true);
    try {
      const sent = await this.api.testAlert();
      this.recentAlerts.reload();
      this.toasts.show(
        sent.body.delivered
          ? { tone: 'success', message: 'Test alert sent. Check your phone.' }
          : {
              tone: 'danger',
              message: 'The test alert was not delivered.',
              detail: sent.body.error ?? undefined,
            },
      );
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
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
        mainEffortYield: this.mainEffortYield,
        dailyBrief: {
          enabled: this.briefEnabled,
          at: this.briefAt,
          timeZone: this.briefTimeZone.trim(),
        },
        alerts: {
          enabled: this.alertsEnabled,
          credentialName: this.alertCredential,
          kinds: this.alertsFor(),
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
