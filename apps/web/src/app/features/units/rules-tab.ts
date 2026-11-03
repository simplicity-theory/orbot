import { Can } from '../../ui/can';
import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { UnitDetailView } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { HoldPolicyControl } from '../../ui/hold-policy';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';

const GATES: Record<string, string> = {
  'approve-everything':
    'You approve every plan and every action that changes something outside the unit.',
  'backbriefs-and-deploys':
    'You approve every backbrief and every production deploy. Everything else proceeds and reaches you only if escalated.',
  'escalations-only': 'Plans proceed on their own; you see only escalations.',
};

/** Standing orders (editable, versioned), rules of engagement and the approval gate. */
@Component({
  selector: 'orb-rules-tab',
  imports: [Can, FormsModule, HoldPolicyControl, Term],
  template: `
    @let u = view().unit;
    <section class="panel" aria-labelledby="so-h">
      <h2 id="so-h" class="panel__title">
        <orb-term key="standing-orders">Standing orders</orb-term>
      </h2>
      @if (editing()) {
        <form class="form" (ngSubmit)="save()">
          <label for="orders">One order per line</label>
          <textarea id="orders" name="orders" class="input" rows="5" [(ngModel)]="text"></textarea>
          <label for="so-reason">Why the change?</label>
          <input id="so-reason" name="reason" class="input" [(ngModel)]="reason" required />
          <div class="actions">
            <button type="button" class="btn btn--ghost" (click)="editing.set(false)">
              Cancel
            </button>
            <button type="submit" class="btn btn--primary" [disabled]="busy() || !reason.trim()">
              Save
            </button>
          </div>
        </form>
      } @else {
        <ul class="bullets">
          @for (o of u.standingOrders; track o.id) {
            <li>{{ o.text }}</li>
          } @empty {
            <li class="meta">None.</li>
          }
        </ul>
        <button *orbCan="view().unit.id" type="button" class="btn" (click)="startEdit()">
          Edit standing orders
        </button>
      }
    </section>

    <section class="panel" aria-labelledby="roe-h">
      <h2 id="roe-h" class="panel__title"><orb-term key="roe">Rules of engagement</orb-term></h2>
      <div class="roe">
        <div>
          <h3>May do alone</h3>
          <ul class="bullets">
            @for (r of u.rulesOfEngagement.mayDoAlone; track r) {
              <li>{{ r }}</li>
            }
          </ul>
        </div>
        <div>
          <h3>Must escalate</h3>
          <ul class="bullets">
            @for (r of u.rulesOfEngagement.mustEscalate; track r) {
              <li>{{ r }}</li>
            }
          </ul>
        </div>
      </div>
    </section>

    <section class="panel" aria-labelledby="hold-h">
      <h2 id="hold-h" class="panel__title">
        <orb-term key="hold-policy">What holds the work</orb-term>
      </h2>
      <orb-hold-policy
        scope="unit"
        [targetId]="u.id"
        [name]="u.name"
        [policy]="u.holdPolicy"
        (changed)="changed.emit()"
      />
    </section>

    <section class="panel" aria-labelledby="gate-h">
      <h2 id="gate-h" class="panel__title">
        <orb-term key="approval-gate">Approval gate</orb-term>
      </h2>
      <p>
        <strong class="mono">{{ u.approvalGate }}</strong> — {{ gates[u.approvalGate] }}
      </p>
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .bullets {
      margin: 0 0 var(--space-3);
      padding-left: var(--space-5);
    }
    .roe {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(var(--card-min-width), 1fr));
      gap: var(--space-4);
      h3 {
        margin-bottom: var(--space-1);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }
    }
  `,
})
export class RulesTab {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly view = input.required<UnitDetailView>();
  readonly changed = output<void>();
  protected readonly gates = GATES;
  protected readonly editing = signal(false);
  protected readonly busy = signal(false);
  protected text = '';
  protected reason = '';

  protected startEdit(): void {
    this.text = this.view()
      .unit.standingOrders.map((o) => o.text)
      .join('\n');
    this.reason = '';
    this.editing.set(true);
  }

  protected async save(): Promise<void> {
    const u = this.view().unit;
    const before = u.standingOrders;
    const byText = new Map(before.map((o) => [o.text, o.id]));
    const orders = this.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((text) => ({ text, ...(byText.has(text) ? { id: byText.get(text)! } : {}) }));
    this.busy.set(true);
    try {
      const saved = await this.api.setStandingOrders(u.id, {
        orders,
        reason: this.reason.trim(),
        expectedVersion: u.version,
      });
      this.editing.set(false);
      this.toasts.show({
        tone: 'success',
        message: `Standing orders updated (${saved.standingOrders.length}).`,
        undo: async () => {
          await this.api.setStandingOrders(u.id, {
            orders: before,
            reason: `Undo: ${this.reason}`,
            expectedVersion: saved.version,
          });
          this.changed.emit();
        },
      });
      this.changed.emit();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
