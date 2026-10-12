import { Component } from '@angular/core';

export const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ['Ctrl/⌘', 'K'], action: 'Command palette: jump anywhere, run actions, search' },
  { keys: ['c'], action: 'Chat with the Overseer of this screen (HQ elsewhere)' },
  { keys: ['g', 'o'], action: 'Go to the ORBAT' },
  { keys: ['g', 'a'], action: 'Go to Approvals (Needs you)' },
  { keys: ['g', 's'], action: 'Go to Sitreps' },
  { keys: ['g', 'r'], action: 'Go to the Archive (the record)' },
  { keys: ['g', 'p'], action: 'Go to Operations' },
  { keys: ['g', 'c'], action: 'Go to full-page chat' },
  { keys: ['g', 'l'], action: 'Go to the orders log' },
  { keys: ['g', 'd'], action: 'Go to the Supply Depot' },
  { keys: ['g', 'x'], action: 'Go to Deconfliction (who touches what)' },
  { keys: ['g', ','], action: 'Go to Settings' },
  { keys: ['?'], action: 'Show this list' },
  { keys: ['Esc'], action: 'Close a dialog or tooltip' },
];

@Component({
  selector: 'orb-shortcuts-dialog',
  template: `
    <h2>Keyboard shortcuts</h2>
    <table>
      <caption class="visually-hidden">
        Keyboard shortcuts
      </caption>
      <tbody>
        @for (s of shortcuts; track s.action) {
          <tr>
            <th scope="row">
              @for (k of s.keys; track $index; let last = $last) {
                <kbd>{{ k }}</kbd>
                @if (!last) {
                  <span class="then">then</span>
                }
              }
            </th>
            <td>{{ s.action }}</td>
          </tr>
        }
      </tbody>
    </table>
    <p class="meta">Shortcuts are ignored while you type in a field (except Ctrl/⌘ K).</p>
  `,
  styles: `
    h2 {
      margin-bottom: var(--space-4);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      padding: var(--space-2) var(--space-4) var(--space-2) 0;
      text-align: left;
      white-space: nowrap;
      font-weight: var(--font-weight-regular);
    }
    td {
      padding: var(--space-2) 0;
      color: var(--color-text-muted);
    }
    tr + tr {
      border-top: var(--border-width) solid var(--color-border);
    }
    .then {
      margin: 0 var(--space-1);
      color: var(--color-text-subtle);
      font-size: var(--font-size-xs);
    }
    .meta {
      margin-top: var(--space-4);
    }
  `,
})
export class ShortcutsDialog {
  protected readonly shortcuts = SHORTCUTS;
}
