import { Component, computed, input } from '@angular/core';
import { STATUS_META, type Status } from '@orbot/shared';
import { Icon } from './icon';

/** One status language everywhere: colour + icon + text label, never colour alone. */
@Component({
  selector: 'orb-status',
  imports: [Icon],
  template: `
    <orb-icon class="sm" [name]="meta().icon" />
    <span>{{ meta().label }}</span>
  `,
  host: {
    '[attr.data-tone]': 'meta().tone',
    '[class.compact]': 'compact()',
  },
  styles: `
    :host {
      --tone: var(--tone-neutral);
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      padding: 0 var(--space-2);
      border-radius: var(--radius-pill);
      background: color-mix(in srgb, var(--tone) 14%, transparent);
      color: var(--tone);
      font-size: var(--font-size-xs);
      font-weight: var(--font-weight-semibold);
      line-height: var(--line-height);
      white-space: nowrap;
      transition:
        color var(--duration) var(--ease),
        background var(--duration) var(--ease);
    }
    :host([data-tone='info']) {
      --tone: var(--tone-info);
    }
    :host([data-tone='active']) {
      --tone: var(--tone-active);
    }
    :host([data-tone='warning']) {
      --tone: var(--tone-warning);
    }
    :host([data-tone='danger']) {
      --tone: var(--tone-danger);
    }
    :host([data-tone='success']) {
      --tone: var(--tone-success);
    }
    :host([data-tone='muted']) {
      --tone: var(--tone-muted);
    }
    :host(.compact) {
      padding: 0;
      background: none;
    }
  `,
})
export class StatusBadge {
  readonly status = input.required<Status>();
  readonly compact = input(false);
  protected readonly meta = computed(() => STATUS_META[this.status()]);
}
