import { afterNextRender, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

/** The page scrolls inside <main>, not the window, so bring `#fragment` into view ourselves. */
export function scrollToFragment(): void {
  const route = inject(ActivatedRoute);
  afterNextRender(() => {
    const id = route.snapshot.fragment;
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 100);
  });
}
