import { httpResource } from '@angular/common/http';
import { Dialog } from '@angular/cdk/dialog';
import { NgTemplateOutlet } from '@angular/common';
import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { BotDetailView, TaskView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { Meta } from '../../core/meta';
import { toUserError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive, touchedIds } from '../../core/live';
import { PageTitle } from '../../core/title';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';
import { RecordTimeline } from '../tasks/record-timeline';
import { openDialog } from '../../ui/dialog';
import { Toasts } from '../../ui/toast';
import { AddBotDialog, type AddBotData } from '../units/add-bot.dialog';

@Component({
  selector: 'orb-bot-page',
  imports: [
    RouterLink,
    StatusBadge,
    Skeleton,
    LoadError,
    Term,
    RecordTimeline,
    NgTemplateOutlet,
    FormsModule,
  ],
  template: `
    @if (view.error(); as err) {
      <div class="page"><orb-load-error [error]="err" (retry)="view.reload()" /></div>
    } @else if (view.hasValue()) {
      @let v = view.value();
      <div class="page page--detail">
        <header class="page-header">
          <div>
            <p class="page-header__eyebrow">
              Bot · {{ v.unit.name }}
              @if (v.bot.isOverseer) {
                · <orb-term key="overseer">Overseer</orb-term>
              }
            </p>
            <h1 class="mono">{{ v.bot.callsign }}</h1>
            <p class="page-header__lede">
              {{ v.bot.role }} ·
              <label for="runtime">runtime</label>
              <select
                id="runtime"
                class="input runtime"
                [value]="v.bot.runtime"
                (change)="switchRuntime($any($event.target).value)"
              >
                @for (r of meta.runtimes(); track r) {
                  <option [value]="r" [selected]="r === v.bot.runtime">{{ r }}</option>
                }
              </select>
            </p>
          </div>
          <div class="header-actions">
            <orb-status [status]="v.bot.status" />
            @if (!v.bot.isOverseer && v.bot.status !== 'stood-down') {
              <button
                type="button"
                class="btn"
                [disabled]="v.bot.status === 'working'"
                (click)="replace()"
              >
                Replace bot…
              </button>
            }
          </div>
        </header>
        @if (v.bot.status === 'stood-down') {
          <p class="panel meta" role="status">
            This bot is stood down. Its work moved to its replacement; its record is kept.
          </p>
        }

        <section class="panel" aria-labelledby="current-h">
          <h2 id="current-h" class="panel__title">Current task</h2>
          @if (v.currentTask; as t) {
            <div class="row">
              <a [routerLink]="taskLink(t)">#{{ t.number }} {{ t.title }}</a>
              <orb-status [status]="t.status" />
            </div>
            @if (t.statusReason) {
              <p class="meta">{{ t.statusReason }}</p>
            }
            <ng-container *ngTemplateOutlet="reassignControl; context: { $implicit: t }" />
          } @else {
            <p class="meta">Idle — nothing in hand.</p>
          }
        </section>

        <section class="panel" aria-labelledby="brief-h">
          <h2 id="brief-h" class="panel__title">Last brief</h2>
          @if (v.lastBrief; as b) {
            <p>Briefed from the unit's documents only:</p>
            <ul class="bullets">
              <li>
                @if (b.body.handoverId) {
                  <a [routerLink]="['/units', v.unit.id, 'documents', b.body.handoverId]"
                    ><orb-term key="handover">Handover</orb-term> v{{ b.body.handoverVersion }}</a
                  >
                } @else {
                  No handover (first time anyone worked this).
                }
              </li>
              <li>
                <a [routerLink]="['/units', v.unit.id]" [queryParams]="{ section: 'field-manual' }"
                  >{{ b.body.fieldManualEntryIds.length }}
                  <orb-term key="field-manual">Field Manual</orb-term> entries</a
                >
              </li>
              <li>
                {{ b.body.diaryEventIds.length }} recent
                <orb-term key="war-diary">War Diary</orb-term> entries
              </li>
            </ul>
          } @else {
            <p class="meta">
              Not briefed yet. Every task starts with a brief from the unit's documents.
            </p>
          }
        </section>

        <section class="panel" aria-labelledby="queue-h">
          <h2 id="queue-h" class="panel__title">Queue ({{ v.queue.length }})</h2>
          @for (t of v.queue; track t.id) {
            <div class="row">
              <a [routerLink]="taskLink(t)">#{{ t.number }} {{ t.title }}</a>
              <orb-status [status]="t.status" />
            </div>
            <ng-container *ngTemplateOutlet="reassignControl; context: { $implicit: t }" />
          } @empty {
            <p class="meta">Queue is empty.</p>
          }
        </section>

        <section class="panel" aria-labelledby="history-h">
          <h2 id="history-h" class="panel__title">Recent history</h2>
          @for (t of v.history; track t.id) {
            <div class="row">
              <a [routerLink]="taskLink(t)">#{{ t.number }} {{ t.title }}</a>
              <orb-status [status]="t.status" />
            </div>
          } @empty {
            <p class="meta">No finished tasks yet.</p>
          }
        </section>

        <section class="panel" aria-labelledby="activity-h">
          <h2 id="activity-h" class="panel__title">Working record (latest first)</h2>
          <orb-record-timeline [events]="v.recent" label="Recent working record" />
        </section>
      </div>
      <ng-template #reassignControl let-t>
        @if (reassignable(t) && v.peers.length) {
          @if (reassigning()?.taskId === t.id) {
            <form class="form reassign" (ngSubmit)="reassign(t)">
              <label [for]="'to-' + t.id">Reassign #{{ t.number }} to</label>
              <select
                class="input"
                [id]="'to-' + t.id"
                name="to"
                [(ngModel)]="reassigning()!.botId"
              >
                @for (p of v.peers; track p.id) {
                  <option [ngValue]="p.id">{{ p.callsign }} — {{ p.role }} ({{ p.status }})</option>
                }
              </select>
              <label [for]="'why-' + t.id">Reason</label>
              <input
                class="input"
                [id]="'why-' + t.id"
                name="why"
                [(ngModel)]="reassigning()!.reason"
                required
              />
              <div class="actions">
                <button type="button" class="btn btn--ghost" (click)="reassigning.set(null)">
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn--primary"
                  [disabled]="busy() || !reassigning()!.reason.trim()"
                >
                  Reassign
                </button>
              </div>
            </form>
          } @else {
            <button
              type="button"
              class="btn btn--ghost small"
              (click)="reassigning.set({ taskId: t.id, botId: v.peers[0]!.id, reason: '' })"
            >
              Reassign #{{ t.number }}…
            </button>
          }
        }
      </ng-template>
    } @else {
      <div class="page page--detail" aria-busy="true">
        <orb-skeleton [lines]="2" />
        <orb-skeleton variant="block" [lines]="2" />
      </div>
    }
  `,
  styles: `
    .runtime {
      min-height: auto;
      margin-left: var(--space-1);
      font-family: var(--font-mono);
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .bullets {
      margin: var(--space-2) 0 0;
      padding-left: var(--space-5);
    }
    .small {
      min-height: auto;
      margin-top: var(--space-1);
      padding: 0 var(--space-2);
      font-size: var(--font-size-sm);
    }
    .reassign {
      margin-top: var(--space-2);
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-3);
      min-height: var(--row-height-dense);
      border-top: var(--border-width) solid var(--color-border);
    }
  `,
})
export class BotPage {
  readonly unitId = input.required<string>();
  readonly botId = input.required<string>();
  protected readonly view = httpResource<BotDetailView>(() => apiUrl.bot(this.botId()));

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      crumbs.set([
        ORBAT_CRUMB,
        { label: v.unit.name, link: `/units/${v.unit.id}` },
        { label: `Bot ${v.bot.callsign}` },
      ]);
      title.set(`Bot ${v.bot.callsign}`);
    });
    reloadOnLive(
      (n) => touchedIds(n).includes(this.botId()),
      () => this.view.reload(),
    );
  }

  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly dialog = inject(Dialog);
  protected readonly busy = signal(false);
  protected readonly reassigning = signal<{ taskId: string; botId: string; reason: string } | null>(
    null,
  );

  protected readonly meta = inject(Meta);

  protected async switchRuntime(runtime: string): Promise<void> {
    const v = this.view.value()!;
    if (runtime === v.bot.runtime) return;
    try {
      await this.api.setBotRuntime(
        v.bot.id,
        runtime,
        `Switched to the ${runtime} runtime by the Commander`,
      );
      this.toasts.show({
        tone: 'success',
        message: `${v.bot.callsign} now runs on ${runtime}.`,
        undo: async () => {
          await this.api.setBotRuntime(v.bot.id, v.bot.runtime, 'Undo runtime switch');
          this.view.reload();
        },
      });
      this.view.reload();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    }
  }

  protected reassignable(t: TaskView): boolean {
    return ['queued', 'blocked', 'stood-down', 'failed'].includes(t.status);
  }

  protected async reassign(t: TaskView): Promise<void> {
    const r = this.reassigning()!;
    const to = this.view.value()!.peers.find((p) => p.id === r.botId);
    this.busy.set(true);
    try {
      await this.api.reassignTask(t.id, r.botId, r.reason.trim());
      this.reassigning.set(null);
      this.toasts.show({
        tone: 'success',
        message: `Task #${t.number} reassigned to ${to?.callsign ?? 'another bot'}.`,
        detail: 'Its branch and handover go with it.',
      });
      this.view.reload();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }

  protected replace(): void {
    const v = this.view.value()!;
    openDialog<unknown, AddBotData, AddBotDialog>(
      this.dialog,
      AddBotDialog,
      {
        unitId: v.unit.id,
        unitName: v.unit.name,
        bots: [v.bot, ...v.peers],
        replacesBotId: v.bot.id,
      },
      'Replace a bot',
    ).closed.subscribe(() => this.view.reload());
  }

  protected taskLink(t: TaskView): string[] {
    return ['/units', t.unitId, 'bots', this.botId(), 'tasks', t.id];
  }
}
