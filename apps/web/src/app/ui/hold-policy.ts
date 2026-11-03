import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  DEFAULT_HOLD_POLICY,
  describeHoldPolicy,
  FIX_UP_TO_LABELS,
  HOLD_FROM_LABELS,
  type HoldPolicy,
} from '@orbot/shared';
import { Api } from '../core/api';
import { toUserError } from '../core/api-error';
import { Can } from './can';
import { Term } from './term';
import { Toasts } from './toast';

type HoldFrom = HoldPolicy['holdFrom'];
type FixUpTo = HoldPolicy['fixUpTo'];
const HOLD_FROM = Object.keys(HOLD_FROM_LABELS) as HoldFrom[];
const FIX_UP_TO = Object.keys(FIX_UP_TO_LABELS) as FixUpTo[];

/**
 * What holds the work and comes to the Commander: set on a unit, or overridden on an
 * operation (where "each unit's own" is the default). The Commander's to change.
 */
@Component({
  selector: 'orb-hold-policy',
  imports: [Can, FormsModule, Term],
  template: `
    <p class="current">
      @if (scope() === 'operation' && !policy()) {
        Each unit’s own hold policy applies to this operation’s work.
      } @else {
        {{ describe(policy() ?? defaults) }}
        @if (effective().holdFrom === 'never') {
          <span class="chip">automatic</span>
        }
      }
    </p>
    <p class="hint">
      The <orb-term key="hold-policy">hold policy</orb-term>: what a bot fixes on its own, what it
      records, and what holds the work for you.
    </p>
    @if (editing()) {
      <form class="form" (ngSubmit)="save()" [attr.aria-label]="'Hold policy for ' + name()">
        @if (scope() === 'operation') {
          <label class="check"
            ><input type="checkbox" name="override" [(ngModel)]="override" /> Override every unit’s
            policy for this operation</label
          >
        }
        @if (scope() === 'unit' || override) {
          <label [for]="id + '-hold'">What holds the work for you</label>
          <select [id]="id + '-hold'" name="holdFrom" class="input" [(ngModel)]="holdFrom">
            @for (h of holdFromOptions; track h) {
              <option [value]="h">{{ holdFromLabels[h] }}</option>
            }
          </select>
          <label [for]="id + '-fix'">What a bot may fix on its own</label>
          <select [id]="id + '-fix'" name="fixUpTo" class="input" [(ngModel)]="fixUpTo">
            @for (f of fixOptions; track f) {
              <option [value]="f">{{ fixLabels[f] }}</option>
            }
          </select>
          <p class="hint">
            A finding within the fix limit is fixed on the spot and committed; otherwise it is
            recorded, and holds the work only from the severity you chose. “Automatic” means nothing
            ever holds: everything is fixed or recorded and the work goes on.
          </p>
        }
        <label [for]="id + '-reason'">Why the change? <span class="hint">(optional)</span></label>
        <input [id]="id + '-reason'" name="reason" class="input" [(ngModel)]="reason" />
        <div class="actions">
          <button type="button" class="btn btn--ghost" (click)="editing.set(false)">Cancel</button>
          <button type="submit" class="btn btn--primary" [disabled]="busy()">Save</button>
        </div>
      </form>
    } @else {
      <button *orbCan="null" type="button" class="btn" (click)="startEdit()">
        Change hold policy
      </button>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .current {
      margin-bottom: var(--space-3);
    }
    .chip {
      margin-left: var(--space-2);
    }
    .check {
      display: flex;
      gap: var(--space-2);
      align-items: baseline;
      font-weight: var(--font-weight-regular);
    }
  `,
})
export class HoldPolicyControl {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  readonly scope = input.required<'unit' | 'operation'>();
  readonly targetId = input.required<string>();
  readonly name = input.required<string>();
  /** The unit's policy, or the operation's override (null = each unit's own). */
  readonly policy = input<HoldPolicy | null>(null);
  readonly changed = output<void>();
  protected readonly editing = signal(false);
  protected readonly busy = signal(false);
  protected readonly defaults = DEFAULT_HOLD_POLICY;
  protected readonly holdFromOptions = HOLD_FROM;
  protected readonly fixOptions = FIX_UP_TO;
  protected readonly holdFromLabels = HOLD_FROM_LABELS;
  protected readonly fixLabels = FIX_UP_TO_LABELS;
  protected readonly describe = describeHoldPolicy;
  protected readonly id = `hold-${Math.random().toString(36).slice(2, 8)}`;
  protected readonly effective = computed(() => this.policy() ?? DEFAULT_HOLD_POLICY);
  protected override = false;
  protected holdFrom: HoldFrom = 'high';
  protected fixUpTo: FixUpTo = 'small';
  protected reason = '';

  protected startEdit(): void {
    const p = this.policy();
    this.override = this.scope() === 'unit' || !!p;
    this.holdFrom = (p ?? DEFAULT_HOLD_POLICY).holdFrom;
    this.fixUpTo = (p ?? DEFAULT_HOLD_POLICY).fixUpTo;
    this.reason = '';
    this.editing.set(true);
  }

  protected async save(): Promise<void> {
    const before = this.policy();
    const next: HoldPolicy | null =
      this.scope() === 'operation' && !this.override
        ? null
        : { holdFrom: this.holdFrom, fixUpTo: this.fixUpTo };
    this.busy.set(true);
    try {
      await this.apply(next, this.reason.trim());
      this.editing.set(false);
      this.toasts.show({
        tone: 'success',
        message: next
          ? `${this.name()}: ${describeHoldPolicy(next)}`
          : `${this.name()} is back to each unit’s own hold policy.`,
        undo: async () => {
          await this.apply(before, `Undo: ${this.reason.trim() || 'hold policy change'}`);
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

  private apply(policy: HoldPolicy | null, reason: string) {
    return this.scope() === 'unit'
      ? this.api.setHoldPolicy(this.targetId(), policy ?? DEFAULT_HOLD_POLICY, reason)
      : this.api.setOperationHoldPolicy(this.targetId(), policy, reason);
  }
}
