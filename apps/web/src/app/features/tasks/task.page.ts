import { Auth } from '../../core/auth';
import { httpResource } from '@angular/common/http';
import { TaskChanges } from '../code/task-changes';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { marked } from 'marked';
import {
  parseHandoverMarkdown,
  type ConnectionSupply,
  type ConnectionView,
  type TaskDetailView,
} from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive, touchedIds } from '../../core/live';
import { PageTitle } from '../../core/title';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { MainEfforts } from '../../core/main-effort';
import { MainEffortBadge } from '../../ui/main-effort';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';
import { PermissionDecision } from '../../ui/permission-decision';
import { DeployApproval } from '../../ui/deploy-approval';
import { RecordTimeline } from './record-timeline';
import { MissionCourse } from '../operations/mission-course';
import { missionStatus } from '../operations/mission-chain';

@Component({
  selector: 'orb-task-page',
  imports: [
    TaskChanges,
    MainEffortBadge,
    RouterLink,
    StatusBadge,
    Skeleton,
    LoadError,
    Term,
    Icon,
    RecordTimeline,
    RelativeTimePipe,
    PermissionDecision,
    DeployApproval,
    MissionCourse,
  ],
  templateUrl: './task.page.html',
  styleUrl: './task.page.scss',
})
export class TaskPage {
  protected readonly auth = inject(Auth);
  protected readonly efforts = inject(MainEfforts);
  readonly unitId = input.required<string>();
  readonly botId = input<string>();
  readonly taskId = input.required<string>();
  protected readonly view = httpResource<TaskDetailView>(() => apiUrl.task(this.taskId()));
  protected readonly full = fullDate;
  protected readonly missionStatus = missionStatus;

  /** Report Markdown, with headings demoted under the page's own. */
  protected md(markdown: string): string {
    return marked.parse(markdown.replace(/^(#{1,4}) /gm, '##$1 '), { async: false });
  }
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly starting = signal(false);
  protected readonly opening = signal(false);
  private readonly connections = httpResource<ConnectionView[]>(() => apiUrl.connections());
  /** A finished task with a branch, whose repository has a code host connected. */
  protected readonly canOpenPr = computed(() => {
    const t = this.view.value()?.task;
    if (!t || t.status !== 'done' || !t.workspace || t.pullRequest || !this.auth.can(t.unitId))
      return false;
    return (this.connections.value() ?? []).some((c) => {
      const s = c.supply.spec as ConnectionSupply;
      return s.repoSupplyId === t.repoSupplyId && s.services.codeHost;
    });
  });

  protected async openPr(): Promise<void> {
    this.opening.set(true);
    try {
      const t = await this.api.openPullRequest(this.taskId());
      this.view.reload();
      this.toasts.show({
        tone: 'success',
        message: `Pull request #${t.pullRequest?.number} opened.`,
        detail: 'The branch was pushed to the code host.',
      });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.opening.set(false);
    }
  }
  /** Why the task waits on someone, as the heading of the decision panel; null when it does not. */
  protected readonly held = computed(() => {
    const t = this.view.value()?.task;
    if (!t) return null;
    switch (t.status) {
      case 'blocked':
        return 'Held for your decision';
      case 'failed':
        return 'Failed: needs your decision';
      case 'awaiting-approval':
        return t.permission?.status === 'pending'
          ? 'Asks your permission'
          : 'Waiting for your approval';
      default:
        return null;
    }
  });
  /** The bot's handover, parsed, for the open problems and next steps it reports. */
  protected readonly note = computed(() => {
    const h = this.view.value()?.handover;
    return h ? parseHandoverMarkdown(h.markdown) : null;
  });
  /** The task's description, with an operation's "Done when" criteria as a list. */
  protected readonly orders = computed(() => {
    const d = this.view.value()?.task.description?.trim();
    if (!d) return null;
    const m = /^([\s\S]*?)\s*Done when:\s*([\s\S]+)$/.exec(d);
    if (!m) return { intro: d, doneWhen: [] as string[] };
    return {
      intro: m[1]!.trim(),
      doneWhen: m[2]!
        .split(/;\s+/)
        .map((s) => s.trim().replace(/\.$/, ''))
        .filter(Boolean),
    };
  });
  protected readonly canStart = computed(() => {
    const t = this.view.value()?.task;
    return (
      !!t &&
      !!t.botId &&
      !!t.repoSupplyId &&
      ['queued', 'blocked', 'stood-down', 'failed'].includes(t.status) &&
      this.auth.can(t.unitId)
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
