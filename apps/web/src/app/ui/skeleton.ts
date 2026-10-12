import { Component, computed, input } from '@angular/core';

/** Placeholder shown while a page loads. Shaped like the content, never a spinner. */
@Component({
  selector: 'orb-skeleton',
  template: `
    @for (w of widths(); track $index) {
      <span class="bar" [style.width.%]="w"></span>
    }
  `,
  host: { 'aria-hidden': 'true', '[class.block]': 'variant() === "block"' },
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .bar {
      display: block;
      height: var(--space-3);
      border-radius: var(--radius-sm);
      background: linear-gradient(
        90deg,
        var(--skeleton-base) 25%,
        var(--skeleton-shine) 50%,
        var(--skeleton-base) 75%
      );
      background-size: 200% 100%;
      animation: shimmer var(--skeleton-duration) linear infinite;
    }
    :host(.block) .bar {
      height: var(--space-16);
      border-radius: var(--radius-lg);
    }
    @keyframes shimmer {
      from {
        background-position: 200% 0;
      }
      to {
        background-position: -200% 0;
      }
    }
  `,
})
export class Skeleton {
  readonly lines = input(3);
  readonly variant = input<'lines' | 'block'>('lines');
  protected readonly widths = computed(() =>
    Array.from({ length: this.lines() }, (_, i) =>
      i === this.lines() - 1 && this.lines() > 1 ? 60 : 100 - (i % 3) * 8,
    ),
  );
}
