import { Component, computed, input, signal } from '@angular/core';
import type { DiffLine } from '@orbot/shared';

interface Row {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pairs removed/added runs so a change sits side by side with what it replaced. */
export function toRows(lines: DiffLine[]): Row[] {
  const rows: Row[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    removed = [];
    added = [];
  };
  for (const l of lines) {
    if (l.kind === 'removed') removed.push(l);
    else if (l.kind === 'added') added.push(l);
    else {
      flush();
      rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}

@Component({
  selector: 'orb-diff-view',
  template: `
    <div class="toolbar">
      <span class="meta">
        <span class="legend removed">−{{ counts().removed }} removed</span>
        <span class="legend added">+{{ counts().added }} added</span>
      </span>
      <div role="group" aria-label="Diff layout">
        <button
          type="button"
          class="btn btn--ghost"
          [attr.aria-pressed]="mode() === 'split'"
          (click)="mode.set('split')"
        >
          Side by side
        </button>
        <button
          type="button"
          class="btn btn--ghost"
          [attr.aria-pressed]="mode() === 'unified'"
          (click)="mode.set('unified')"
        >
          Unified
        </button>
      </div>
    </div>
    @if (mode() === 'split') {
      <table class="diff split" [attr.aria-label]="label()">
        <thead>
          <tr>
            <th scope="col" colspan="2">{{ leftLabel() }}</th>
            <th scope="col" colspan="2">{{ rightLabel() }}</th>
          </tr>
        </thead>
        <tbody>
          @for (r of rows(); track $index) {
            <tr>
              <td class="no">{{ r.left?.leftNo }}</td>
              <td class="code" [class.removed]="r.left?.kind === 'removed'">
                @if (r.left?.kind === 'removed') {
                  <span class="visually-hidden">Removed: </span>
                }
                {{ r.left?.text }}
              </td>
              <td class="no">{{ r.right?.rightNo }}</td>
              <td class="code" [class.added]="r.right?.kind === 'added'">
                @if (r.right?.kind === 'added') {
                  <span class="visually-hidden">Added: </span>
                }
                {{ r.right?.text }}
              </td>
            </tr>
          }
        </tbody>
      </table>
    } @else {
      <table class="diff" [attr.aria-label]="label()">
        <tbody>
          @for (l of lines(); track $index) {
            <tr>
              <td class="no">{{ l.leftNo }}</td>
              <td class="no">{{ l.rightNo }}</td>
              <td
                class="code"
                [class.added]="l.kind === 'added'"
                [class.removed]="l.kind === 'removed'"
              >
                <span aria-hidden="true">{{
                  l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : ' '
                }}</span>
                @if (l.kind !== 'same') {
                  <span class="visually-hidden">{{
                    l.kind === 'added' ? 'Added: ' : 'Removed: '
                  }}</span>
                }
                {{ l.text }}
              </td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-2);
    }
    .legend {
      margin-right: var(--space-3);
    }
    .legend.removed {
      color: var(--tone-danger);
    }
    .legend.added {
      color: var(--tone-success);
    }
    [aria-pressed='true'] {
      background: var(--color-surface-3);
      border-color: var(--color-border-strong);
    }
    .diff {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-family: var(--font-mono);
      font-size: var(--font-size-sm);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    th {
      padding: var(--space-2);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
      font-family: var(--font-sans);
      font-weight: var(--font-weight-semibold);
      text-align: left;
    }
    .no {
      width: var(--space-10);
      padding: 0 var(--space-2);
      color: var(--color-text-subtle);
      text-align: right;
      vertical-align: top;
      user-select: none;
    }
    .code {
      padding: 0 var(--space-2);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .added {
      background: var(--diff-added-bg);
    }
    .removed {
      background: var(--diff-removed-bg);
    }
  `,
})
export class DiffView {
  readonly lines = input.required<DiffLine[]>();
  readonly leftLabel = input('Before');
  readonly rightLabel = input('After');
  readonly label = input('Differences between versions');
  protected readonly mode = signal<'split' | 'unified'>('split');
  protected readonly rows = computed(() => toRows(this.lines()));
  protected readonly counts = computed(() => ({
    added: this.lines().filter((l) => l.kind === 'added').length,
    removed: this.lines().filter((l) => l.kind === 'removed').length,
  }));
}
