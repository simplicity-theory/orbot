import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { CommitOrigin } from '@orbot/shared';

const KIND: Record<CommitOrigin['kind'], string> = {
  commit: 'Committed by',
  integration: 'Integrated by HQ for',
  handoff: 'Handed off at, by HQ, for',
  deployment: 'Deployed by',
};

/** Who made a commit, from the record, with links up the chain of command. */
@Component({
  selector: 'orb-commit-origin',
  imports: [RouterLink],
  template: `
    @let o = origin();
    @if (o) {
      <span class="origin">
        {{ kind() }}
        @if (o.botCallsign && o.unitId && o.botId) {
          <a class="mono" [routerLink]="['/units', o.unitId, 'bots', o.botId]">{{
            o.botCallsign
          }}</a>
        }
        @if (o.unitName && o.unitId) {
          (<a [routerLink]="['/units', o.unitId]">{{ o.unitName }}</a
          >)
        }
        @if (taskLink(); as l) {
          on <a [routerLink]="l">task #{{ o.taskNumber }}</a>
          @if (!compact()) {
            <span class="meta">{{ o.taskTitle }}</span>
          }
        }
        @if (o.operationId && o.operationName) {
          · <a [routerLink]="['/operations', o.operationId]">Operation {{ o.operationName }}</a>
        }
      </span>
    } @else {
      <span class="meta">Not made by a bot on record</span>
    }
  `,
  host: { style: 'display: contents' },
  styles: `
    a {
      text-decoration: underline;
    }
  `,
})
export class CommitOriginLine {
  readonly origin = input.required<CommitOrigin | null>();
  readonly compact = input(false);
  protected readonly kind = computed(() => KIND[this.origin()?.kind ?? 'commit']);
  protected readonly taskLink = computed(() => {
    const o = this.origin();
    if (!o?.taskId || !o.unitId) return null;
    return o.botId
      ? ['/units', o.unitId, 'bots', o.botId, 'tasks', o.taskId]
      : ['/units', o.unitId, 'tasks', o.taskId];
  });
}
