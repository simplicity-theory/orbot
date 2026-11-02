import { Component, computed, input, model } from '@angular/core';
import { resourceKindOf, type ResourceKind, type SupplyView } from '@orbot/shared';

const GROUPS: { kind: ResourceKind; label: string }[] = [
  { kind: 'repository', label: 'Repositories' },
  { kind: 'server', label: 'Servers' },
  { kind: 'environment', label: 'Environments' },
  { kind: 'model', label: 'Models' },
  { kind: 'credential', label: 'Credentials' },
];

/** Tick the depot items an operation should have. Repositories first: work lands there. */
@Component({
  selector: 'orb-resource-picker',
  template: `
    <fieldset class="picker">
      <legend>{{ legend() }}</legend>
      @for (g of groups(); track g.kind) {
        <div class="group" role="group" [attr.aria-label]="g.label">
          <span class="meta">{{ g.label }}</span>
          @for (s of g.items; track s.id) {
            <label class="check"
              ><input
                type="checkbox"
                [checked]="selected().includes(s.id)"
                (change)="toggle(s.id, $any($event.target).checked)"
              />
              {{ s.name }}
              @if (tier(s); as t) {
                <span class="chip">{{ t }}</span>
              }
            </label>
          }
        </div>
      } @empty {
        <p class="meta">Nothing connected in the Supply Depot yet.</p>
      }
    </fieldset>
  `,
  styles: `
    .picker {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      margin: 0;
      padding: 0;
      border: 0;
      legend {
        margin-bottom: var(--space-2);
        font-weight: var(--font-weight-medium);
      }
    }
    .group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2) var(--space-4);
      .meta {
        flex-basis: 100%;
      }
    }
    .check {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      font-weight: var(--font-weight-regular);
    }
  `,
})
export class ResourcePicker {
  readonly supply = input.required<SupplyView[]>();
  readonly legend = input('Resources');
  /** Supply ids, in the order ticked. */
  readonly selected = model<string[]>([]);

  protected readonly groups = computed(() =>
    GROUPS.map((g) => ({
      ...g,
      items: this.supply().filter((s) => s.connected && resourceKindOf(s) === g.kind),
    })).filter((g) => g.items.length),
  );

  protected tier(s: SupplyView): string | null {
    return s.spec.kind === 'environment' ? (s.spec.details['tier'] ?? null) : null;
  }

  protected toggle(id: string, on: boolean): void {
    this.selected.update((ids) =>
      on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id),
    );
  }
}
