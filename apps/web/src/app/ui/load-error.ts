import { Component, computed, input, output } from '@angular/core';
import { toUserError } from '../core/api-error';
import { Icon } from './icon';

/** Plain-language failure panel with a retry. */
@Component({
  selector: 'orb-load-error',
  imports: [Icon],
  template: `
    <div class="panel" role="alert">
      <orb-icon name="triangle-alert" />
      <div>
        <p class="msg">{{ e().message }}</p>
        <p class="meta">{{ e().action }}</p>
      </div>
      <button type="button" class="btn" (click)="retry.emit()">Retry</button>
    </div>
  `,
  styles: `
    .panel {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      border-color: var(--tone-danger);
    }
    orb-icon {
      color: var(--tone-danger);
    }
    div {
      flex: 1;
    }
    .msg {
      font-weight: var(--font-weight-medium);
    }
  `,
})
export class LoadError {
  readonly error = input.required<unknown>();
  readonly retry = output<void>();
  protected readonly e = computed(() => toUserError(this.error()));
}
