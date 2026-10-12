import { Component, computed, input } from '@angular/core';
import type { OperationPhase } from '@orbot/shared';
import { Term } from './term';

const PHASES: { id: OperationPhase; label: string; term?: string }[] = [
  { id: 'intent', label: 'Intent', term: 'intent' },
  { id: 'o-group', label: 'O Group', term: 'o-group' },
  { id: 'backbrief', label: 'Backbrief', term: 'backbrief' },
  { id: 'execution', label: 'Execution' },
  { id: 'handoffs', label: 'Handoffs', term: 'handoff' },
  { id: 'sitreps', label: 'Sitreps', term: 'sitrep' },
  { id: 'after-action', label: 'After Action', term: 'after-action' },
  { id: 'closed', label: 'Closed' },
];

/** Where an operation is in its lifecycle. */
@Component({
  selector: 'orb-phase-stepper',
  imports: [Term],
  template: `
    <ol class="list-reset steps" [attr.aria-label]="'Operation phase: ' + current().label">
      @for (p of phases; track p.id; let i = $index) {
        <li
          [class.done]="i < index()"
          [class.current]="i === index()"
          [attr.aria-current]="i === index() ? 'step' : null"
        >
          <span class="dot" aria-hidden="true"></span>
          @if (p.term && !compact()) {
            <orb-term [key]="p.term">{{ p.label }}</orb-term>
          } @else {
            <span>{{ p.label }}</span>
          }
          @if (i < index()) {
            <span class="visually-hidden">(done)</span>
          }
        </li>
      }
    </ol>
  `,
  styles: `
    .steps {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-3);
      font-size: var(--font-size-sm);
    }
    li {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      color: var(--color-text-subtle);
    }
    .dot {
      width: var(--space-2);
      height: var(--space-2);
      border-radius: var(--radius-pill);
      border: var(--border-width) solid currentColor;
    }
    .done {
      color: var(--color-text-muted);
      .dot {
        background: var(--tone-success);
        border-color: var(--tone-success);
      }
    }
    .current {
      color: var(--color-text);
      font-weight: var(--font-weight-semibold);
      .dot {
        background: var(--color-accent);
        border-color: var(--color-accent);
      }
    }
  `,
})
export class PhaseStepper {
  readonly phase = input.required<OperationPhase>();
  readonly compact = input(false);
  protected readonly phases = PHASES;
  protected readonly index = computed(() => PHASES.findIndex((p) => p.id === this.phase()));
  protected readonly current = computed(() => PHASES[this.index()] ?? PHASES[0]!);
}
