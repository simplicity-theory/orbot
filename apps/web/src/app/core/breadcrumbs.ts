import { Injectable, signal } from '@angular/core';

export interface Crumb {
  label: string;
  /** Router link; omitted for the current page. */
  link?: string;
  /** Glossary key, if the label is a military term. */
  term?: string;
}

/**
 * Breadcrumbs mirror the chain of command: ORBAT › Engineers › Bot E-3 › Task #142.
 * Each page sets its trail once it knows the names involved.
 */
@Injectable({ providedIn: 'root' })
export class Breadcrumbs {
  readonly trail = signal<Crumb[]>([]);

  set(trail: Crumb[]): void {
    this.trail.set(trail);
  }
}

export const ORBAT_CRUMB: Crumb = { label: 'ORBAT', link: '/', term: 'orbat' };
