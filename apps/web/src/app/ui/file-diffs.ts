import { Component, computed, input } from '@angular/core';
import type { FileDiff } from '@orbot/shared';

const STATUS: Record<FileDiff['status'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
};

/**
 * Code changes, file by file: a summary line per file (+/−), then its hunks with the old and new
 * line numbers. Small changes open; long ones start folded.
 */
@Component({
  selector: 'orb-file-diffs',
  template: `
    @if (files().length) {
      <p class="meta totals">
        {{ files().length }} file{{ files().length === 1 ? '' : 's' }} ·
        <span class="plus">+{{ totals().added }}</span>
        <span class="minus">−{{ totals().removed }}</span>
        @if (truncated()) {
          · more files changed than are shown
        }
      </p>
      @for (f of files(); track f.path) {
        <details class="file" [open]="openAll()">
          <summary>
            <span class="mono path">
              @if (f.oldPath) {
                {{ f.oldPath }} →
              }
              {{ f.path }}
            </span>
            <span class="chip">{{ status(f) }}</span>
            <span class="counts">
              <span class="plus">+{{ f.added }}</span>
              <span class="minus">−{{ f.removed }}</span>
            </span>
          </summary>
          @if (f.binary) {
            <p class="meta note">A binary file: not shown.</p>
          } @else if (!f.hunks.length) {
            <p class="meta note">No line changes (renamed or mode changed).</p>
          } @else {
            <div class="scroll">
              <table class="code" [attr.aria-label]="'Changes to ' + f.path">
                @for (h of f.hunks; track $index) {
                  <tbody>
                    <tr class="hunk">
                      <td colspan="3" class="mono">{{ h.header }}</td>
                    </tr>
                    @for (l of h.lines; track $index) {
                      <tr [class]="l.kind">
                        <td class="no">{{ l.leftNo }}</td>
                        <td class="no">{{ l.rightNo }}</td>
                        <td class="line">
                          @if (l.kind === 'added') {
                            <span class="visually-hidden">Added: </span>
                          } @else if (l.kind === 'removed') {
                            <span class="visually-hidden">Removed: </span>
                          }
                          <span aria-hidden="true" class="sign">{{
                            l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : ' '
                          }}</span
                          >{{ l.text }}
                        </td>
                      </tr>
                    }
                  </tbody>
                }
              </table>
            </div>
            @if (f.truncated) {
              <p class="meta note">Cut short: the file's diff is too long to show in full.</p>
            }
          }
        </details>
      }
    } @else {
      <p class="meta">{{ empty() }}</p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      min-width: 0;
    }
    .plus {
      color: var(--tone-success);
    }
    .minus {
      color: var(--tone-danger);
    }
    .file {
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    summary {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      background: var(--color-surface-2);
      cursor: pointer;
    }
    .path {
      flex: 1 1 auto;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .counts {
      display: inline-flex;
      gap: var(--space-2);
      font-size: var(--font-size-sm);
    }
    .note {
      padding: var(--space-2) var(--space-3);
    }
    .scroll {
      overflow-x: auto;
    }
    .code {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: var(--font-size-xs);
      line-height: var(--line-height);
    }
    td {
      padding: 0 var(--space-2);
      vertical-align: top;
    }
    .no {
      width: 1%;
      color: var(--color-text-subtle);
      text-align: right;
      white-space: nowrap;
      user-select: none;
    }
    .line {
      white-space: pre;
    }
    .sign {
      display: inline-block;
      width: var(--space-3);
      user-select: none;
    }
    .hunk td {
      padding: var(--space-1) var(--space-2);
      background: var(--color-surface-3);
      color: var(--color-text-muted);
    }
    .added {
      background: var(--diff-added-bg);
    }
    .removed {
      background: var(--diff-removed-bg);
    }
  `,
})
export class FileDiffs {
  readonly files = input.required<FileDiff[]>();
  readonly truncated = input(false);
  readonly empty = input('No changes.');
  protected readonly totals = computed(() =>
    this.files().reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), {
      added: 0,
      removed: 0,
    }),
  );
  /** Open every file when the whole change is short enough to read at once. */
  protected readonly openAll = computed(
    () =>
      this.files().reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0) <= 400,
  );

  protected status(f: FileDiff): string {
    return STATUS[f.status];
  }
}
