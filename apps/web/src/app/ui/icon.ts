import { Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { ICONS, type IconName } from './icons';

/** Decorative by default (aria-hidden). Pass `label` when the icon carries meaning on its own. */
@Component({
  selector: 'orb-icon',
  template: `<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    [attr.aria-hidden]="label() ? null : 'true'"
    [attr.role]="label() ? 'img' : null"
    [attr.aria-label]="label()"
    [innerHTML]="svg()"
  ></svg>`,
  styles: `
    :host {
      display: inline-flex;
      flex-shrink: 0;
      width: var(--icon-size);
      height: var(--icon-size);
    }
    :host(.sm) {
      width: var(--icon-size-sm);
      height: var(--icon-size-sm);
    }
    :host(.lg) {
      width: var(--icon-size-lg);
      height: var(--icon-size-lg);
    }
    :host(.xl) {
      width: var(--icon-size-xl);
      height: var(--icon-size-xl);
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `,
})
export class Icon {
  private readonly sanitizer = inject(DomSanitizer);
  readonly name = input.required<IconName | string>();
  readonly label = input<string | null>(null);
  protected readonly svg = computed(() =>
    // Safe: ICONS is a compile-time constant, never user input.
    this.sanitizer.bypassSecurityTrustHtml(ICONS[this.name() as IconName] ?? ICONS.circle),
  );
}
