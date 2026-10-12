import { inject, Injectable } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { TitleStrategy, type RouterStateSnapshot } from '@angular/router';
import { Meta } from './meta';

/** "<page> · <product name>". Pages with dynamic names call `PageTitle.set`. */
@Injectable({ providedIn: 'root' })
export class PageTitle extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const t = this.buildTitle(snapshot);
    if (t) this.set(t);
  }

  set(page: string): void {
    const product = this.meta.productName();
    this.title.setTitle(product ? `${page} · ${product}` : page);
  }
}
