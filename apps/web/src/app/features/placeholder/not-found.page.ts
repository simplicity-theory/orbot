import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { EmptyState } from '../../ui/empty-state';

@Component({
  selector: 'orb-not-found-page',
  imports: [EmptyState, RouterLink],
  template: `
    <div class="page">
      <orb-empty-state icon="search" title="Nothing at this address">
        The link may be mistyped, or point at something that never existed. (Nothing in ORBOT is
        ever deleted.)
        <div actions><a class="btn btn--primary" routerLink="/">Back to the ORBAT</a></div>
      </orb-empty-state>
    </div>
  `,
})
export class NotFoundPage {
  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Not found' }]);
  }
}
