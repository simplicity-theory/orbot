import { httpResource } from '@angular/common/http';
import { Component, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { UnitDetailView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive, touchedIds } from '../../core/live';
import { PageTitle } from '../../core/title';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';

@Component({
  selector: 'orb-unit-page',
  imports: [RouterLink, StatusBadge, Skeleton, LoadError, Term, Icon, RelativeTimePipe],
  templateUrl: './unit.page.html',
  styleUrl: './unit.page.scss',
})
export class UnitPage {
  readonly unitId = input.required<string>();
  protected readonly view = httpResource<UnitDetailView>(() => apiUrl.unit(this.unitId()));
  private readonly crumbs = inject(Breadcrumbs);
  private readonly title = inject(PageTitle);

  constructor() {
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      this.crumbs.set([ORBAT_CRUMB, { label: v.unit.name }]);
      this.title.set(v.unit.name);
    });
    reloadOnLive(
      (n) => touchedIds(n).includes(this.unitId()),
      () => this.view.reload(),
    );
  }
}
