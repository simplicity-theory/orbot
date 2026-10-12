import { Component, input } from '@angular/core';
import { Icon } from './icon';
import type { IconName } from './icons';

/** Explains what a screen is for and offers the first action. */
@Component({
  selector: 'orb-empty-state',
  imports: [Icon],
  template: `
    <orb-icon class="xl" [name]="icon()" />
    <h2>{{ title() }}</h2>
    <div class="body"><ng-content /></div>
    <div class="actions"><ng-content select="[actions]" /></div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-12) var(--space-6);
      border: var(--border-width) dashed var(--color-border-strong);
      border-radius: var(--radius-lg);
      text-align: center;
      color: var(--color-text-muted);
    }
    orb-icon {
      color: var(--color-text-subtle);
    }
    h2 {
      color: var(--color-text);
      font-size: var(--font-size-lg);
    }
    .body {
      max-width: var(--measure);
    }
    .actions:empty {
      display: none;
    }
  `,
})
export class EmptyState {
  readonly icon = input<IconName>('info');
  readonly title = input.required<string>();
}
