import { httpResource } from '@angular/common/http';
import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { TaskChangesView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { reloadOnLive } from '../../core/live';
import { FileDiffs } from '../../ui/file-diffs';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';

/** What a task did to the code: its commits, the whole diff since its base, and what is not committed yet. */
@Component({
  selector: 'orb-task-changes',
  imports: [FileDiffs, LoadError, RelativeTimePipe, RouterLink, Skeleton],
  template: `
    <h2 id="changes-h" class="panel__title">
      Code changes
      @if (view.value(); as v) {
        @if (v.repository) {
          <span class="meta"
            ><a [routerLink]="['/supply/repositories', v.repository.id]">{{ v.repository.name }}</a>
            @if (v.branch) {
              · <span class="mono">{{ v.branch }}</span>
            }
          </span>
        }
      }
    </h2>
    @if (view.error(); as err) {
      <orb-load-error [error]="err" (retry)="view.reload()" />
    } @else if (view.value(); as v) {
      @if (!v.repository) {
        <p class="meta">No workspace yet: the bot has not started on the code.</p>
      } @else {
        <h3 class="sub">Commits ({{ v.commits.length }})</h3>
        @if (v.commits.length) {
          <ol class="list-reset commits">
            @for (c of v.commits; track c.sha) {
              <li>
                <a [routerLink]="['/supply/repositories', v.repository.id, 'commits', c.sha]">
                  <span class="mono">{{ c.sha.slice(0, 10) }}</span> {{ c.subject }}
                </a>
                <time class="meta" [attr.datetime]="c.date" [attr.title]="full(c.date)">{{
                  c.date | relativeTime
                }}</time>
              </li>
            }
          </ol>
        } @else {
          <p class="meta">None yet.</p>
        }
        <h3 class="sub">Everything it changed</h3>
        <orb-file-diffs
          [files]="v.files"
          [truncated]="v.truncated"
          empty="Nothing committed yet."
        />
        @if (v.uncommitted.length) {
          <h3 class="sub">Not committed yet</h3>
          <orb-file-diffs [files]="v.uncommitted" />
        }
      }
    } @else {
      <orb-skeleton [lines]="4" />
    }
  `,
  host: { class: 'panel', role: 'region', 'aria-labelledby': 'changes-h' },
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      min-width: 0;
    }
    .panel__title a {
      text-decoration: underline;
    }
    .sub {
      font-size: var(--font-size-sm);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-muted);
    }
    .commits li {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: var(--space-2);
      padding: var(--space-1) 0;
      a {
        overflow-wrap: anywhere;
      }
    }
  `,
})
export class TaskChanges {
  readonly taskId = input.required<string>();
  protected readonly view = httpResource<TaskChangesView>(() => apiUrl.taskChanges(this.taskId()));
  protected readonly full = fullDate;

  constructor() {
    reloadOnLive(
      (n) =>
        n.type === 'event' &&
        n.event.taskId === this.taskId() &&
        ['artifact', 'run.finished', 'workspace.prepared'].includes(n.event.kind),
      () => this.view.reload(),
    );
  }
}
