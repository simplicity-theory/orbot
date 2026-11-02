import { Dialog } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  meetsNeed,
  resourceKindOf,
  type OperationResourcesView,
  type SupplyView,
} from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError } from '../../core/api-error';
import { Can } from '../../ui/can';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icon';
import { Toasts } from '../../ui/toast';
import { MoveRepositoryDialog, type MoveRepositoryData } from './operation-course';

const KIND_LABEL: Record<string, string> = {
  repository: 'repository',
  server: 'server',
  environment: 'environment',
  model: 'model',
  credential: 'credential',
};

/**
 * What an operation needs from the Supply Depot, what it has been given, and what is missing.
 * Missing something it must have, it waits at the O Group: assign it here or in chat.
 */
@Component({
  selector: 'orb-operation-resources',
  imports: [Can, FormsModule, Icon, RouterLink],
  template: `
    @let r = resources();
    <h2 id="resources-h" class="panel__title">Resources</h2>
    @if (r.blocked) {
      <p class="waiting" role="status">
        <orb-icon name="triangle-alert" />
        <span
          >Waiting at the O Group for what it must have. HQ carries on as soon as it is assigned,
          here or in chat (“Use … for Operation {{ name() }}”).</span
        >
      </p>
    }
    <h3 class="sub">Needs</h3>
    <ul class="list-reset needs">
      @for (n of r.needs; track $index) {
        <li [class.missing]="!n.metBy.length && !n.need.optional">
          <orb-icon
            class="sm"
            [name]="n.metBy.length ? 'check' : n.need.optional ? 'circle' : 'x'"
          />
          <span>
            {{ n.need.label }}
            @if (n.need.optional) {
              <span class="chip">optional</span>
            }
            @if (n.metBy.length) {
              <span class="meta">· {{ namesOf(n.metBy) }}</span>
            } @else if (!canMeet(n.need)) {
              <span class="meta"
                >· nothing in the depot can meet it yet.
                <a routerLink="/supply" [queryParams]="{ section: sectionFor(n.need.kind) }"
                  >Connect one</a
                ></span
              >
            }
          </span>
        </li>
      }
    </ul>

    <h3 class="sub">Assigned</h3>
    @if (r.assigned.length) {
      <ul class="list-reset assigned" aria-label="Assigned resources">
        @for (s of r.assigned; track s.id) {
          <li class="chip" [class.main]="s.id === r.mainRepositoryId">
            <span>{{ s.name }}</span>
            <span class="kind">{{ kindOf(s) }}</span>
            @if (s.id === r.mainRepositoryId) {
              <span class="tag">main</span>
            }
            @if (open()) {
              @if (s.spec.kind === 'repository' && s.id !== r.mainRepositoryId) {
                <button
                  *orbCan="null"
                  type="button"
                  class="make-main"
                  [disabled]="busy()"
                  [attr.aria-label]="'Make ' + s.name + ' the main repository'"
                  (click)="makeMain(s)"
                >
                  Make main
                </button>
              }
              @if (s.id !== r.mainRepositoryId || !missionsOut()) {
                <button
                  *orbCan="null"
                  type="button"
                  class="x"
                  [disabled]="busy()"
                  [attr.aria-label]="'Take ' + s.name + ' off the operation'"
                  (click)="release(s)"
                >
                  <orb-icon class="sm" name="x" />
                </button>
              }
            }
          </li>
        }
      </ul>
      @if (open() && missionsOut() && repositoryCount() > 1) {
        <p class="meta">
          Work lands in the main repository. To move the operation, make another one main: its
          missions are issued again there.
        </p>
      }
    } @else {
      <p class="meta">Nothing yet.</p>
    }
    @if (open()) {
      <form class="assign" *orbCan="null" (ngSubmit)="assign()">
        <label for="assign-res" class="visually-hidden">Resource to assign</label>
        <select id="assign-res" name="res" class="input" [(ngModel)]="choice">
          <option [ngValue]="null" disabled>Assign from the Supply Depot…</option>
          @for (s of available(); track s.id) {
            <option [ngValue]="s.id">{{ s.name }} ({{ kindOf(s) }})</option>
          }
        </select>
        <button type="submit" class="btn" [disabled]="busy() || !choice">Assign</button>
      </form>
    }
  `,
  host: { class: 'panel', id: 'resources', role: 'region', 'aria-labelledby': 'resources-h' },
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      scroll-margin-top: var(--space-16);
    }
    .waiting {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      padding: var(--space-3);
      border: var(--border-width) solid var(--tone-warning);
      border-radius: var(--radius-md);
    }
    .sub {
      font-size: var(--font-size-sm);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-muted);
    }
    .needs {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      li {
        display: flex;
        align-items: flex-start;
        gap: var(--space-2);
      }
      orb-icon {
        flex: none;
        margin-top: var(--space-1);
        color: var(--tone-success);
      }
      .missing orb-icon {
        color: var(--tone-danger);
      }
      .missing {
        font-weight: var(--font-weight-medium);
      }
      a {
        text-decoration: underline;
      }
    }
    .assigned {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      .chip {
        padding-right: 0;
      }
      .kind {
        color: var(--color-text-subtle);
      }
      .main {
        border-color: var(--color-accent);
      }
      .tag {
        font-weight: var(--font-weight-semibold);
        color: var(--color-accent);
      }
    }
    .make-main {
      border: 0;
      background: none;
      color: var(--color-accent);
      font: inherit;
      text-decoration: underline;
      cursor: pointer;
    }
    .x {
      display: inline-flex;
      min-width: var(--space-6);
      min-height: var(--space-6);
      align-items: center;
      justify-content: center;
      border: 0;
      background: none;
      color: inherit;
      cursor: pointer;
    }
    .assign {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      select {
        flex: 1 1 auto;
        min-width: 0;
      }
    }
  `,
})
export class OperationResources {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly dialog = inject(Dialog);
  readonly operationId = input.required<string>();
  readonly name = input.required<string>();
  readonly phase = input.required<string>();
  readonly resources = input.required<OperationResourcesView>();
  /** Missions are issued: moving to another repository issues them again. */
  readonly missionsOut = input(false);
  readonly changed = output<void>();
  private readonly supply = httpResource<SupplyView[]>(() => apiUrl.supply());
  protected readonly busy = signal(false);
  protected choice: string | null = null;

  protected readonly open = computed(() => !['after-action', 'closed'].includes(this.phase()));
  /** Connected depot items an operation can use that it does not have yet. */
  protected readonly available = computed(() => {
    const assigned = new Set(this.resources().assigned.map((s) => s.id));
    return (this.supply.value() ?? []).filter(
      (s) => s.connected && resourceKindOf(s) && !assigned.has(s.id),
    );
  });

  protected readonly repositoryCount = computed(
    () => this.resources().assigned.filter((s) => s.spec.kind === 'repository').length,
  );

  protected makeMain(s: SupplyView): void {
    if (!this.missionsOut()) {
      void this.act(async () => {
        await this.api.setMainRepository(this.operationId(), s.id);
        return `${s.name} is now the main repository of Operation ${this.name()}.`;
      });
      return;
    }
    const from = this.resources().assigned.find((x) => x.id === this.resources().mainRepositoryId);
    openDialog<boolean, MoveRepositoryData, MoveRepositoryDialog>(
      this.dialog,
      MoveRepositoryDialog,
      {
        operationId: this.operationId(),
        name: this.name(),
        to: { id: s.id, name: s.name },
        from: from?.name ?? null,
      },
      `Move Operation ${this.name()} to ${s.name}`,
    ).closed.subscribe((done) => {
      if (!done) return;
      this.toasts.show({
        tone: 'success',
        message: `Operation ${this.name()} moves to ${s.name}.`,
        detail: 'Its missions are issued again there; each unit briefs back.',
      });
      this.changed.emit();
    });
  }

  protected kindOf(s: SupplyView): string {
    const k = resourceKindOf(s);
    const tier = s.spec.kind === 'environment' ? s.spec.details['tier'] : null;
    return `${KIND_LABEL[k ?? ''] ?? s.spec.kind}${tier ? ` · ${tier}` : ''}`;
  }

  protected namesOf(ids: string[]): string {
    return this.resources()
      .assigned.filter((s) => ids.includes(s.id))
      .map((s) => s.name)
      .join(', ');
  }

  /** Something in the depot (assigned or not) could meet this need. */
  protected canMeet(need: OperationResourcesView['needs'][number]['need']): boolean {
    return (this.supply.value() ?? []).some((s) => meetsNeed(need, s));
  }

  protected sectionFor(kind: string): string {
    return kind === 'repository'
      ? 'repositories'
      : kind === 'credential'
        ? 'credentials'
        : kind === 'model'
          ? 'models'
          : 'environments';
  }

  protected assign(): Promise<void> {
    const id = this.choice;
    const s = (this.supply.value() ?? []).find((x) => x.id === id);
    if (!id || !s) return Promise.resolve();
    return this.act(async () => {
      await this.api.assignResource(this.operationId(), id);
      this.choice = null;
      return `${s.name} assigned to Operation ${this.name()}.`;
    });
  }

  protected release(s: SupplyView): Promise<void> {
    return this.act(async () => {
      await this.api.releaseResource(this.operationId(), s.id);
      return `${s.name} taken off Operation ${this.name()}.`;
    });
  }

  private async act(fn: () => Promise<string>): Promise<void> {
    this.busy.set(true);
    try {
      this.toasts.show({ tone: 'success', message: await fn() });
      this.changed.emit();
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
