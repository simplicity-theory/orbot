import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { TaskDetailView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive, touchedIds } from '../../core/live';
import { PageTitle } from '../../core/title';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';
import { RecordTimeline } from './record-timeline';

@Component({
  selector: 'orb-task-page',
  imports: [
    RouterLink,
    StatusBadge,
    Skeleton,
    LoadError,
    Term,
    Icon,
    RecordTimeline,
    RelativeTimePipe,
  ],
  templateUrl: './task.page.html',
  styleUrl: './task.page.scss',
})
export class TaskPage {
  readonly unitId = input.required<string>();
  readonly botId = input<string>();
  readonly taskId = input.required<string>();
  protected readonly view = httpResource<TaskDetailView>(() => apiUrl.task(this.taskId()));
  protected readonly full = fullDate;
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly starting = signal(false);
  protected readonly canStart = computed(() => {
    const t = this.view.value()?.task;
    return (
      !!t && !!t.botId && !!t.repoSupplyId && ['queued', 'blocked', 'stood-down'].includes(t.status)
    );
  });
  protected readonly statusHistory = computed(() => {
    const v = this.view.value();
    if (!v) return [];
    return v.versions.map((ver) => ({
      version: ver.version,
      status: (ver.body as { status: TaskDetailView['task']['status'] }).status,
      reason: ver.reason,
      actor: ver.actor,
      at: ver.createdAt,
    }));
  });

  /** Optimistic: the button disables at once; live updates then show the bot working. */
  protected async start(): Promise<void> {
    const t = this.view.value()?.task;
    if (!t) return;
    this.starting.set(true);
    try {
      await this.api.runTask(t.id);
      this.toasts.show({
        tone: 'success',
        message: `Task #${t.number} started.`,
        detail: 'Progress appears in the working record as it happens.',
      });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.starting.set(false);
    }
  }

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      const trail = [ORBAT_CRUMB, { label: v.unit.name, link: `/units/${v.unit.id}` }];
      if (v.bot)
        trail.push({
          label: `Bot ${v.bot.callsign}`,
          link: `/units/${v.unit.id}/bots/${v.bot.id}`,
        });
      crumbs.set([...trail, { label: `Task #${v.task.number}` }]);
      title.set(`Task #${v.task.number}`);
    });
    reloadOnLive(
      (n) => touchedIds(n).includes(this.taskId()),
      () => this.view.reload(),
    );
  }
}
