import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { MissionStatus, OperationMissionView, Status } from '@orbot/shared';
import { Icon } from '../../ui/icon';
import { StatusBadge } from '../../ui/status-badge';

export const missionStatus = (s: MissionStatus): Status =>
  s === 'planning' || s === 'waiting' ? 'queued' : s === 'withdrawn' ? 'stood-down' : s;

/** The units of an operation in handoff order, with progress. */
@Component({
  selector: 'orb-mission-chain',
  imports: [RouterLink, Icon, StatusBadge],
  template: `
    <ol class="list-reset chain" aria-label="Missions in handoff order">
      @for (m of missions(); track m.mission.id; let last = $last) {
        <li>
          <div class="unit">
            <a [routerLink]="['/units', m.unit.id]" [queryParams]="{ mission: m.mission.id }">{{
              m.unit.name
            }}</a>
            <span class="meta">{{ m.mission.stage ?? 'mission' }}</span>
            <orb-status [status]="status(m.mission.status)" />
            @if (m.mission.status === 'waiting') {
              <span class="meta">waiting for handoff</span>
            }
            <span class="meta">{{ m.done }}/{{ m.total }} done</span>
          </div>
          @if (!last) {
            <orb-icon class="arrow" name="arrow-right" />
          }
        </li>
      }
    </ol>
  `,
  styles: `
    .chain {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      li {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
    }
    .unit {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      padding: var(--space-2) var(--space-3);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      a {
        font-weight: var(--font-weight-semibold);
      }
    }
    .arrow {
      color: var(--color-text-subtle);
    }
  `,
})
export class MissionChain {
  readonly missions = input.required<OperationMissionView[]>();
  protected readonly status = missionStatus;
}
