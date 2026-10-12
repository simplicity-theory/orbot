import { Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { OrbatUnit } from '@orbot/shared';
import { Meta } from '../../core/meta';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';

/** The order of battle as a tree: Commander › units › Overseer › bots. */
@Component({
  selector: 'orb-orbat-tree',
  imports: [RouterLink, StatusBadge, Term],
  template: `
    <ul class="tree list-reset" role="tree" aria-label="Order of battle">
      <li role="treeitem" aria-expanded="true" aria-selected="false">
        <span class="node root"
          >Commander <span class="meta">(you) · {{ meta.productName() }}</span></span
        >
        <ul role="group" class="list-reset">
          <li role="treeitem" aria-expanded="true" aria-selected="false">
            <span class="node"
              ><orb-term key="hq">HQ</orb-term>
              <span class="meta">routes operations to units (Phase 4)</span></span
            >
            <ul role="group" class="list-reset">
              @for (u of units(); track u.unit.id) {
                <li role="treeitem" aria-expanded="true" aria-selected="false">
                  <span class="node">
                    <a [routerLink]="['/units', u.unit.id]">{{ u.unit.name }}</a>
                    <span class="meta">{{ u.unit.role }}</span>
                    <orb-status [status]="u.status" />
                    @if (u.attention.length) {
                      <a class="needs" [routerLink]="['/units', u.unit.id]"
                        >{{ u.attention.length }} need you</a
                      >
                    }
                  </span>
                  <ul role="group" class="list-reset">
                    <li role="treeitem" aria-expanded="true" aria-selected="false">
                      <span class="node">
                        @if (u.overseer; as o) {
                          <a class="mono" [routerLink]="['/units', u.unit.id, 'bots', o.id]">{{
                            o.callsign
                          }}</a>
                          <span class="meta"><orb-term key="overseer">Overseer</orb-term></span>
                        } @else {
                          <span class="meta">No Overseer</span>
                        }
                      </span>
                      <ul role="group" class="list-reset">
                        @for (b of u.bots; track b.id) {
                          <li role="treeitem" aria-selected="false">
                            <span class="node">
                              <a class="mono" [routerLink]="['/units', u.unit.id, 'bots', b.id]">{{
                                b.callsign
                              }}</a>
                              <orb-status [status]="b.status" [compact]="true" />
                              @if (b.currentTask; as t) {
                                <a
                                  class="task"
                                  [routerLink]="['/units', u.unit.id, 'bots', b.id, 'tasks', t.id]"
                                  >#{{ t.number }} {{ t.title }}</a
                                >
                              }
                            </span>
                          </li>
                        }
                      </ul>
                    </li>
                  </ul>
                </li>
              }
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  `,
  styles: `
    .tree {
      padding: var(--space-4);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: var(--color-surface-1);
    }
    ul[role='group'] {
      margin-left: var(--space-3);
      padding-left: var(--space-4);
      border-left: var(--border-width) solid var(--color-border);
    }
    .node {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      min-height: var(--row-height-dense);
    }
    .root {
      font-weight: var(--font-weight-semibold);
    }
    .needs {
      color: var(--tone-warning);
      font-size: var(--font-size-sm);
    }
    .task {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
    }
  `,
})
export class OrbatTree {
  protected readonly meta = inject(Meta);
  readonly units = input.required<OrbatUnit[]>();
}
