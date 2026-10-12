import { inject, Pipe, type PipeTransform } from '@angular/core';
import { Router, type UrlTree } from '@angular/router';

/**
 * An app link from the API (e.g. `/disputes#dispute-1`) as a UrlTree, so `routerLink`
 * keeps its fragment and query instead of encoding them into the path.
 */
@Pipe({ name: 'url' })
export class UrlPipe implements PipeTransform {
  private readonly router = inject(Router);

  transform(link: string): UrlTree {
    return this.router.parseUrl(link);
  }
}
