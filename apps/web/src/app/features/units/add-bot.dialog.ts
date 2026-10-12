import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import type { BotView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Toasts } from '../../ui/toast';

export interface AddBotData {
  unitId: string;
  unitName: string;
  bots: BotView[];
  /** Pre-select a bot to replace. */
  replacesBotId?: string | null;
}

/** Add a bot to a unit, or replace one: the old bot stands down and its work moves over. */
@Component({
  selector: 'orb-add-bot-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>{{ replaces ? 'Replace a bot' : 'Add a bot' }} in {{ data.unitName }}</h2>
      <p class="hint">
        A new bot knows nothing but the unit's documents: its brief comes from the handover, the
        Field Manual and the War Diary.
      </p>
      <label for="replaces">Replaces</label>
      <select id="replaces" name="replaces" class="input" [(ngModel)]="replaces">
        <option [ngValue]="null">Nobody — add a bot</option>
        @for (b of data.bots; track b.id) {
          <option [ngValue]="b.id" [disabled]="b.status === 'working'">
            {{ b.callsign }} — {{ b.role }}{{ b.status === 'working' ? ' (working)' : '' }}
          </option>
        }
      </select>
      <label for="role">Role</label>
      <input id="role" name="role" class="input" required [(ngModel)]="role" />
      <label for="reason">Reason</label>
      <input
        id="reason"
        name="reason"
        class="input"
        required
        [(ngModel)]="reason"
        placeholder="e.g. E-1 rotated out"
      />
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Cancel</button>
        <button
          type="submit"
          class="btn btn--primary"
          [disabled]="busy() || !role.trim() || !reason.trim()"
        >
          {{ replaces ? 'Replace' : 'Add bot' }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class AddBotDialog {
  protected readonly data = inject<AddBotData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected replaces: string | null = this.data.replacesBotId ?? null;
  protected role =
    this.data.bots.find((b) => b.id === this.data.replacesBotId)?.role ?? 'Developer';
  protected reason = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const old = this.data.bots.find((b) => b.id === this.replaces);
      const bot = await this.api.addBot(this.data.unitId, {
        role: this.role.trim(),
        replacesBotId: this.replaces,
        reason: this.reason.trim(),
      });
      this.toasts.show({
        tone: 'success',
        message: old
          ? `${bot.callsign} replaces ${old.callsign}.`
          : `${bot.callsign} joined ${this.data.unitName}.`,
        detail: old
          ? `${old.callsign} stood down; its unfinished work moved to ${bot.callsign}.`
          : undefined,
      });
      this.ref.close(bot);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
