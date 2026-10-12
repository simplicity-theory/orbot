import { httpResource } from '@angular/common/http';
import { Component, computed, input, output } from '@angular/core';
import type { UnitView } from '@orbot/shared';
import { apiUrl } from '../../core/api';

/** Choose who to talk to: HQ or a unit's Overseer. */
@Component({
  selector: 'orb-channel-picker',
  template: `
    <label class="visually-hidden" [for]="id">Talk to</label>
    <select
      class="input"
      [id]="id"
      [value]="channel()"
      (change)="picked.emit($any($event.target).value)"
    >
      <option value="hq">HQ</option>
      @for (u of units(); track u.id) {
        <option [value]="u.id" [selected]="u.id === channel()">{{ u.name }} Overseer</option>
      }
    </select>
  `,
})
export class ChannelPicker {
  readonly channel = input.required<string>();
  readonly picked = output<string>();
  private readonly list = httpResource<UnitView[]>(() => apiUrl.units());
  protected readonly units = computed(() => this.list.value() ?? []);
  protected readonly id = `channel-${Math.random().toString(36).slice(2, 8)}`;
}
