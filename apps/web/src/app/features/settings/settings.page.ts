import { Component, inject } from '@angular/core';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { Meta } from '../../core/meta';
import { ThemeService } from '../../core/theme';

@Component({
  selector: 'orb-settings-page',
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1>Settings</h1>
          <p class="page-header__lede">How {{ meta.productName() }} looks and runs.</p>
        </div>
      </header>
      <section class="panel" aria-labelledby="appearance-h">
        <h2 id="appearance-h" class="panel__title">Appearance</h2>
        <fieldset>
          <legend>Theme</legend>
          <label
            ><input
              type="radio"
              name="theme"
              value="dark"
              [checked]="theme.theme() === 'dark'"
              (change)="theme.theme.set('dark')"
            />
            Dark</label
          >
          <label
            ><input
              type="radio"
              name="theme"
              value="light"
              [checked]="theme.theme() === 'light'"
              (change)="theme.theme.set('light')"
            />
            Light</label
          >
        </fieldset>
      </section>
      <section class="panel" aria-labelledby="system-h">
        <h2 id="system-h" class="panel__title">System</h2>
        <dl class="dl">
          <dt>Product name</dt>
          <dd>{{ meta.productName() }} <span class="meta">(ORBOT_PRODUCT_NAME)</span></dd>
          <dt>Bot runtime</dt>
          <dd class="mono">{{ meta.runtime() }}</dd>
        </dl>
      </section>
    </div>
  `,
  styles: `
    fieldset {
      display: flex;
      gap: var(--space-4);
      margin: 0;
      padding: 0;
      border: 0;
    }
    legend {
      margin-bottom: var(--space-2);
      color: var(--color-text-muted);
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      cursor: pointer;
    }
  `,
})
export class SettingsPage {
  protected readonly theme = inject(ThemeService);
  protected readonly meta = inject(Meta);
  constructor() {
    inject(Breadcrumbs).set([ORBAT_CRUMB, { label: 'Settings' }]);
  }
}
