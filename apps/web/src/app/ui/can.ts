import { Directive, effect, inject, input, TemplateRef, ViewContainerRef } from '@angular/core';
import { Auth } from '../core/auth';

/**
 * Shows its content only to someone who may order it: `*orbCan="unitId"` (that unit's
 * Captain or the Commander), `*orbCan="null"` (the Commander), `*orbCan="'officer'"` (any
 * officer who gives orders). The server enforces the same rules either way.
 */
@Directive({ selector: '[orbCan]' })
export class Can {
  readonly orbCan = input.required<string | null>();
  private readonly auth = inject(Auth);
  private readonly tpl = inject(TemplateRef<unknown>);
  private readonly vcr = inject(ViewContainerRef);
  private shown = false;

  constructor() {
    effect(() => {
      const ok = this.auth.can(this.orbCan());
      if (ok && !this.shown) this.vcr.createEmbeddedView(this.tpl);
      if (!ok && this.shown) this.vcr.clear();
      this.shown = ok;
    });
  }
}
