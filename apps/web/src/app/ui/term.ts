import { Component, computed, input, signal } from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { GLOSSARY } from '@orbot/shared';

let nextId = 0;

const POSITIONS: ConnectedPosition[] = [
  { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
  { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
];

/**
 * A military term with a glossary tooltip on hover and keyboard focus.
 * Definitions come from the single glossary in @orbot/shared.
 */
@Component({
  selector: 'orb-term',
  imports: [CdkConnectedOverlay, CdkOverlayOrigin],
  template: `
    <span
      class="term"
      cdkOverlayOrigin
      #origin="cdkOverlayOrigin"
      tabindex="0"
      [attr.aria-describedby]="entry() ? id : null"
      (mouseenter)="open.set(true)"
      (mouseleave)="open.set(false)"
      (focus)="open.set(true)"
      (blur)="open.set(false)"
      (keydown.escape)="open.set(false)"
      ><ng-content
    /></span>
    @if (entry(); as e) {
      <span class="visually-hidden" [id]="id">{{ e.term }}: {{ e.short }}. {{ e.meaning }}</span>
      <ng-template
        cdkConnectedOverlay
        [cdkConnectedOverlayOrigin]="origin"
        [cdkConnectedOverlayOpen]="open()"
        [cdkConnectedOverlayPositions]="positions"
      >
        <div class="tooltip" role="tooltip" aria-hidden="true">
          <strong>{{ e.term }}</strong> — {{ e.short }}
          <p>{{ e.meaning }}</p>
        </div>
      </ng-template>
    }
  `,
  styles: `
    .term {
      text-decoration: underline dotted;
      text-decoration-color: var(--color-text-subtle);
      text-underline-offset: var(--underline-offset);
      cursor: help;
    }
    .tooltip {
      max-width: var(--tooltip-max-width);
      padding: var(--space-2) var(--space-3);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-surface-3);
      color: var(--color-text);
      box-shadow: var(--shadow-2);
      font-size: var(--font-size-sm);
      font-weight: var(--font-weight-regular);
      letter-spacing: normal;
      text-transform: none;
      line-height: var(--line-height);
      p {
        margin-top: var(--space-1);
        color: var(--color-text-muted);
      }
    }
  `,
})
export class Term {
  readonly key = input.required<string>();
  protected readonly entry = computed(() => GLOSSARY[this.key()] ?? null);
  protected readonly open = signal(false);
  protected readonly positions = POSITIONS;
  protected readonly id = `orb-term-${nextId++}`;
}
