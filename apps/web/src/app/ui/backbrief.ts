import { Auth } from '../core/auth';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { BackbriefView, ProposedTask } from '@orbot/shared';
import { Api } from '../core/api';
import { toUserError } from '../core/api-error';
import { NeedsYou } from '../core/needs-you';
import { Icon } from './icon';
import { StatusBadge } from './status-badge';
import { Term } from './term';
import { Toasts } from './toast';

type Mode = 'view' | 'amend' | 'reject';

let seq = 0;

/**
 * A unit's plan, briefed back for a decision: approve, approve with changes, or
 * send back with a note. Works inline wherever a backbrief appears.
 */
@Component({
  selector: 'orb-backbrief',
  imports: [FormsModule, Icon, StatusBadge, Term],
  template: `
    @let bb = backbrief();
    <article class="bb" [attr.aria-labelledby]="id + '-h'" [id]="'backbrief-' + bb.id">
      <header>
        <div>
          <p class="eyebrow">
            <orb-term key="backbrief">Backbrief</orb-term> · {{ bb.unitName }}
            @if (bb.round > 1) {
              · round {{ bb.round }}
            }
          </p>
          <h3 [id]="id + '-h'">{{ bb.mission.goal }}</h3>
        </div>
        <orb-status
          [status]="
            bb.status === 'awaiting-approval'
              ? 'awaiting-approval'
              : bb.status === 'approved'
                ? 'done'
                : 'failed'
          "
        />
      </header>
      <p>{{ bb.summary }}</p>

      <table class="tasks">
        <caption class="visually-hidden">
          Proposed tasks
        </caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Task</th>
            <th scope="col">Bot</th>
            @if (mode() === 'amend') {
              <th scope="col"><span class="visually-hidden">Remove</span></th>
            }
          </tr>
        </thead>
        <tbody>
          @if (mode() === 'amend') {
            @for (t of draft(); track $index; let i = $index) {
              <tr>
                <td>{{ i + 1 }}</td>
                <td>
                  <label class="visually-hidden" [for]="id + '-t' + i"
                    >Task {{ i + 1 }} title</label
                  >
                  <input
                    class="input"
                    [id]="id + '-t' + i"
                    [ngModel]="t.title"
                    (ngModelChange)="patch(i, { title: $event })"
                  />
                </td>
                <td>
                  <label class="visually-hidden" [for]="id + '-b' + i">Task {{ i + 1 }} bot</label>
                  <select
                    class="input"
                    [id]="id + '-b' + i"
                    [ngModel]="t.botId"
                    (ngModelChange)="patch(i, { botId: $event })"
                  >
                    <option [ngValue]="null">Unassigned</option>
                    @for (b of bots(); track b.id) {
                      <option [ngValue]="b.id">{{ b.callsign }}</option>
                    }
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    class="btn btn--ghost btn--icon"
                    [attr.aria-label]="'Remove task ' + (i + 1)"
                    [disabled]="draft().length === 1"
                    (click)="remove(i)"
                  >
                    <orb-icon name="x" />
                  </button>
                </td>
              </tr>
            }
          } @else {
            @for (t of bb.proposedTasks; track $index; let i = $index) {
              <tr>
                <td>{{ i + 1 }}</td>
                <td>{{ t.title }}</td>
                <td class="mono">{{ t.botId ? (bb.callsigns[t.botId] ?? '?') : 'Unassigned' }}</td>
              </tr>
            }
          }
        </tbody>
      </table>
      @if (mode() === 'amend') {
        <button type="button" class="btn btn--ghost add" (click)="add()">
          <orb-icon name="arrow-right" /> Add a task
        </button>
      }

      @if (bb.risks.length) {
        <h4>Risks and notes</h4>
        <ul class="bullets">
          @for (r of bb.risks; track $index) {
            <li>{{ r }}</li>
          }
        </ul>
      }

      @if (bb.status === 'awaiting-approval' && auth.can(bb.unitId)) {
        @if (mode() === 'view') {
          <div class="actions">
            <button type="button" class="btn btn--primary" [disabled]="busy()" (click)="approve()">
              Approve
            </button>
            <button type="button" class="btn" [disabled]="busy()" (click)="startAmend()">
              Amend…
            </button>
            <button
              type="button"
              class="btn btn--ghost"
              [disabled]="busy()"
              (click)="mode.set('reject')"
            >
              Send back…
            </button>
          </div>
        } @else {
          <div class="note">
            <label [for]="id + '-note'">{{
              mode() === 'amend'
                ? 'What did you change, and why?'
                : 'What should the Overseer change?'
            }}</label>
            <textarea
              class="input"
              rows="2"
              [id]="id + '-note'"
              [(ngModel)]="note"
              required
            ></textarea>
          </div>
          <div class="actions">
            @if (mode() === 'amend') {
              <button
                type="button"
                class="btn btn--primary"
                [disabled]="busy() || !note.trim()"
                (click)="amend()"
              >
                Approve with changes
              </button>
            } @else {
              <button
                type="button"
                class="btn btn--primary"
                [disabled]="busy() || !note.trim()"
                (click)="reject()"
              >
                Send back
              </button>
            }
            <button type="button" class="btn btn--ghost" [disabled]="busy()" (click)="cancel()">
              Cancel
            </button>
          </div>
        }
      } @else if (bb.decision; as d) {
        <p class="meta">
          {{ d.outcome }} by <span class="mono">{{ d.by }}</span
          >{{ d.note ? ' — “' + d.note + '”' : '' }}
        </p>
      }
    </article>
  `,
  styles: `
    .bb {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--space-3);
    }
    .eyebrow {
      color: var(--color-text-subtle);
      font-size: var(--font-size-xs);
      font-weight: var(--font-weight-semibold);
      letter-spacing: var(--letter-spacing-caps);
      text-transform: uppercase;
    }
    h3 {
      font-size: var(--font-size-lg);
    }
    h4 {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
    }
    .tasks {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--font-size-sm);
      th {
        color: var(--color-text-subtle);
        font-weight: var(--font-weight-medium);
        text-align: left;
        padding: var(--space-1) var(--space-2) var(--space-1) 0;
      }
      td {
        padding: var(--space-1) var(--space-2) var(--space-1) 0;
        border-top: var(--border-width) solid var(--color-border);
        vertical-align: middle;
      }
      .input {
        width: 100%;
      }
    }
    .add {
      align-self: flex-start;
    }
    .bullets {
      margin: 0;
      padding-left: var(--space-5);
    }
    .note {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      textarea {
        padding: var(--space-2) var(--space-3);
        resize: vertical;
      }
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
  `,
})
export class Backbrief {
  protected readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly needsYou = inject(NeedsYou);

  readonly backbrief = input.required<BackbriefView>();
  readonly decided = output<BackbriefView>();

  protected readonly id = `bb-${seq++}`;
  protected readonly mode = signal<Mode>('view');
  protected readonly busy = signal(false);
  protected readonly draft = signal<ProposedTask[]>([]);
  protected note = '';
  protected readonly bots = computed(() =>
    Object.entries(this.backbrief().callsigns)
      .filter(([id]) => id !== this.backbrief().overseerBotId)
      .map(([id, callsign]) => ({ id, callsign }))
      .sort((a, b) => a.callsign.localeCompare(b.callsign, undefined, { numeric: true })),
  );

  protected startAmend(): void {
    this.draft.set(this.backbrief().proposedTasks.map((t) => ({ ...t })));
    this.mode.set('amend');
  }

  protected patch(i: number, p: Partial<ProposedTask>): void {
    this.draft.update((d) => d.map((t, j) => (j === i ? { ...t, ...p } : t)));
  }

  protected remove(i: number): void {
    this.draft.update((d) => d.filter((_, j) => j !== i));
  }

  protected add(): void {
    this.draft.update((d) => [
      ...d,
      { title: 'New task', description: '', botId: null, scenario: 'happy-path', kind: 'work' },
    ]);
  }

  protected cancel(): void {
    this.mode.set('view');
    this.note = '';
  }

  protected approve(): Promise<void> {
    const bb = this.backbrief();
    return this.act(
      () => this.api.approveBackbrief(bb.id, bb.version),
      (r) => `Approved. ${r.taskIds.length} task(s) issued to ${bb.unitName}.`,
    );
  }

  protected amend(): Promise<void> {
    const bb = this.backbrief();
    return this.act(
      () =>
        this.api.amendBackbrief(bb.id, {
          proposedTasks: this.draft(),
          note: this.note.trim(),
          expectedVersion: bb.version,
        }),
      (r) => `Approved with changes. ${r.taskIds.length} task(s) issued to ${bb.unitName}.`,
    );
  }

  protected reject(): Promise<void> {
    const bb = this.backbrief();
    return this.act(
      () => this.api.rejectBackbrief(bb.id, bb.version, this.note.trim()),
      () => `Sent back to ${bb.unitName}'s Overseer to re-plan.`,
    );
  }

  private async act(
    call: () => Promise<BackbriefView>,
    message: (r: BackbriefView) => string,
  ): Promise<void> {
    this.busy.set(true);
    try {
      const r = await call();
      // Decisions issue work at once, so they cannot be undone (no Undo on this toast).
      this.toasts.show({
        tone: 'success',
        message: message(r),
        detail: 'A decision on a backbrief cannot be undone once work is issued.',
      });
      this.mode.set('view');
      this.note = '';
      this.needsYou.reload();
      this.decided.emit(r);
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
