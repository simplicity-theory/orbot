import { OverlayContainer } from '@angular/cdk/overlay';
import { afterNextRender, Component, ElementRef, inject, Injectable, signal } from '@angular/core';
import { Icon } from './icon';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'danger';
  message: string;
  detail?: string;
  /** Present when the change can be reversed (by a new entry, never a delete). */
  undo?: () => void | Promise<void>;
}

let seq = 0;

@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly items = signal<Toast[]>([]);

  show(t: Omit<Toast, 'id'>, ttlMs = 6000): void {
    const toast = { ...t, id: ++seq };
    this.items.update((xs) => [...xs, toast]);
    setTimeout(() => this.dismiss(toast.id), ttlMs);
  }

  dismiss(id: number): void {
    this.items.update((xs) => xs.filter((x) => x.id !== id));
  }
}

/** Live region in the shell where toasts appear. */
@Component({
  selector: 'orb-toast-outlet',
  imports: [Icon],
  template: `
    @for (t of toasts.items(); track t.id) {
      <div
        class="toast"
        [attr.data-tone]="t.tone"
        [attr.role]="t.tone === 'danger' ? 'alert' : 'status'"
      >
        <orb-icon
          [name]="t.tone === 'danger' ? 'triangle-alert' : t.tone === 'success' ? 'check' : 'info'"
        />
        <div class="text">
          <p>{{ t.message }}</p>
          @if (t.detail) {
            <p class="meta">{{ t.detail }}</p>
          }
        </div>
        @if (t.undo; as undo) {
          <button type="button" class="btn btn--ghost" (click)="undo(); toasts.dismiss(t.id)">
            Undo
          </button>
        }
        <button
          type="button"
          class="btn btn--ghost btn--icon"
          aria-label="Dismiss"
          (click)="toasts.dismiss(t.id)"
        >
          <orb-icon name="x" />
        </button>
      </div>
    }
  `,
  host: { 'aria-live': 'polite' },
  styles: `
    :host {
      position: fixed;
      right: var(--space-4);
      bottom: var(--space-4);
      z-index: var(--layer-overlay);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      max-width: var(--measure);
      pointer-events: auto;
    }
    .toast {
      --tone: var(--tone-info);
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      padding: var(--space-3);
      border: var(--border-width) solid var(--color-border-strong);
      border-left: calc(var(--border-width) * 4) solid var(--tone);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      box-shadow: var(--shadow-2);
    }
    .toast[data-tone='success'] {
      --tone: var(--tone-success);
    }
    .toast[data-tone='danger'] {
      --tone: var(--tone-danger);
    }
    orb-icon {
      color: var(--tone);
      margin-top: var(--space-1);
    }
    .text {
      flex: 1;
    }
  `,
})
export class ToastOutlet {
  protected readonly toasts = inject(Toasts);

  constructor() {
    // Live inside the CDK overlay container: when a dialog is open, CDK hides everything
    // outside it from assistive tech, and toasts must stay announced and reachable.
    const host = inject(ElementRef<HTMLElement>).nativeElement;
    const container = inject(OverlayContainer);
    afterNextRender(() => container.getContainerElement().appendChild(host));
  }
}
