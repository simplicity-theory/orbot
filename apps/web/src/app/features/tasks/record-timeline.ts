import { afterRenderEffect, Component, computed, input, signal, viewChild } from '@angular/core';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import type { RecordEvent } from '@orbot/shared';
import { Icon } from '../../ui/icon';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { describeEvent } from './describe-event';

/**
 * A bot's working record: one dense row per record event, virtual-scrolled so
 * long diaries stay fast. Selecting a row shows the full entry.
 */
@Component({
  selector: 'orb-record-timeline',
  imports: [ScrollingModule, Icon, RelativeTimePipe],
  template: `
    @if (rows().length) {
      <cdk-virtual-scroll-viewport [itemSize]="rowPx" class="viewport" [style.height.px]="height()">
        <ol class="list-reset" [attr.aria-label]="label()">
          <li *cdkVirtualFor="let r of rows(); trackBy: trackSeq" [attr.data-tone]="r.s.tone">
            <button
              type="button"
              class="row"
              [attr.aria-pressed]="selected()?.seq === r.e.seq"
              (click)="selected.set(selected()?.seq === r.e.seq ? null : r.e)"
            >
              <orb-icon class="sm" [name]="r.s.icon" />
              <span class="label">{{ r.s.label }}</span>
              <span class="text">{{ r.s.text }}</span>
              <time [attr.datetime]="r.e.createdAt" [attr.title]="full(r.e.createdAt)">{{
                r.e.createdAt | relativeTime
              }}</time>
            </button>
          </li>
        </ol>
      </cdk-virtual-scroll-viewport>
      @if (selected(); as e) {
        <section class="detail" aria-live="polite" aria-label="Selected entry">
          <p class="meta">
            #{{ e.seq }} · {{ e.kind }} · by <span class="mono">{{ e.actor }}</span> ·
            {{ full(e.createdAt) }}
          </p>
          <pre class="prose">{{ pretty(e.body) }}</pre>
        </section>
      }
    } @else {
      <p class="meta">Nothing recorded yet.</p>
    }
  `,
  styles: `
    .viewport {
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
    }
    li {
      --tone: var(--color-text-subtle);
    }
    li[data-tone='info'] {
      --tone: var(--tone-info);
    }
    li[data-tone='warning'] {
      --tone: var(--tone-warning);
    }
    li[data-tone='danger'] {
      --tone: var(--tone-danger);
    }
    li[data-tone='success'] {
      --tone: var(--tone-success);
    }
    .row {
      display: grid;
      grid-template-columns:
        var(--icon-size-sm) var(--timeline-label-width) minmax(0, 1fr)
        max-content;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      height: var(--row-height-dense);
      padding: 0 var(--space-3);
      border: 0;
      border-bottom: var(--border-width) solid var(--color-border);
      background: none;
      color: var(--color-text);
      font: inherit;
      font-size: var(--font-size-sm);
      text-align: left;
      cursor: pointer;
      &:hover,
      &[aria-pressed='true'] {
        background: var(--color-surface-2);
      }
    }
    orb-icon {
      color: var(--tone);
    }
    .label {
      color: var(--color-text-muted);
      font-weight: var(--font-weight-medium);
      white-space: nowrap;
    }
    .text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    time {
      color: var(--color-text-subtle);
      font-size: var(--font-size-xs);
    }
    .detail {
      margin-top: var(--space-3);
      padding: var(--space-3);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      .prose {
        margin-top: var(--space-2);
      }
    }
    @media (max-width: 48rem) {
      .row {
        grid-template-columns: var(--icon-size-sm) minmax(0, 1fr) max-content;
      }
      .label {
        display: none;
      }
    }
  `,
})
export class RecordTimeline {
  readonly events = input.required<RecordEvent[]>();
  readonly label = input('Working record');
  /** Newest first. */
  readonly newestFirst = input(false);
  protected readonly rowPx = 36;
  protected readonly selected = signal<RecordEvent | null>(null);
  protected readonly rows = computed(() => {
    const evs = this.newestFirst() ? [...this.events()].reverse() : this.events();
    return evs.map((e) => ({ e, s: describeEvent(e) }));
  });
  protected readonly height = computed(() => Math.min(this.rows().length, 14) * this.rowPx + 2);
  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  constructor() {
    // The viewport grows with the list (up to a cap); tell CDK to re-measure so new rows render.
    afterRenderEffect(() => {
      this.height();
      this.viewport()?.checkViewportSize();
    });
  }

  protected readonly trackSeq = (_: number, r: { e: RecordEvent }) => r.e.seq;
  protected readonly full = fullDate;
  protected pretty(body: unknown): string {
    return JSON.stringify(body, null, 2);
  }
}
