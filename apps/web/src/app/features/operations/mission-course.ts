import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { MissionStatus } from '@orbot/shared';
import { Api } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Auth } from '../../core/auth';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icon';
import { Toasts } from '../../ui/toast';

export type CourseKind = 'abort-mission' | 'restart-mission' | 'restart-operation';

export interface CourseData {
  kind: CourseKind;
  /** The mission or operation id. */
  id: string;
  /** The mission's goal, or the operation's name. */
  label: string;
  unitName: string | null;
  inOperation: boolean;
}

const COPY: Record<
  CourseKind,
  { title: (d: CourseData) => string; hint: (d: CourseData) => string; verb: string; done: string }
> = {
  'abort-mission': {
    title: (d) => `Abort the mission “${d.label}”`,
    hint: (d) =>
      `${d.unitName ?? 'The unit'} stops: running work stops with a handover, nothing waiting starts, and the mission is withdrawn. Everything done stays on record.${d.inOperation ? ' The operation cannot finish without this stage: start the mission over, or cancel the operation.' : ''}`,
    verb: 'Abort mission',
    done: 'Mission aborted.',
  },
  'restart-mission': {
    title: (d) => `Start the mission “${d.label}” over`,
    hint: (d) =>
      `Its work stands down and the mission is withdrawn; HQ issues it again to ${d.unitName ?? 'the unit'} with the same goal${d.inOperation ? ', in the same place in the chain' : ''}, and ${d.unitName ?? 'the unit'} briefs back afresh. Everything done stays on record.`,
    verb: 'Start over',
    done: 'Mission started over.',
  },
  'restart-operation': {
    title: (d) => `Start Operation ${d.label} over`,
    hint: () =>
      'Every mission is withdrawn: running work stops with a handover, nothing waiting starts. HQ issues them again from the same plan on the same resources, and each unit briefs back afresh. Everything done stays on record and on the integration branch.',
    verb: 'Start over',
    done: 'Operation started over.',
  },
};

/** Ask why (optional), then abort a mission, start it over, or start an operation over. */
@Component({
  selector: 'orb-course-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>{{ copy.title(data) }}</h2>
      <p class="hint">{{ copy.hint(data) }}</p>
      <label for="course-note">Why (optional)</label>
      <input
        id="course-note"
        name="note"
        class="input"
        [(ngModel)]="note"
        placeholder="e.g. Wrong brief; starting again"
      />
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Keep it</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy()">{{ copy.verb }}</button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class CourseDialog {
  protected readonly data = inject<CourseData>(DIALOG_DATA);
  protected readonly copy = COPY[this.data.kind];
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  protected note = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const note = this.note.trim();
      if (this.data.kind === 'abort-mission') await this.api.abortMission(this.data.id, note);
      else if (this.data.kind === 'restart-mission')
        await this.api.restartMission(this.data.id, note);
      else await this.api.restartOperation(this.data.id, note);
      this.ref.close(true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/**
 * "Abort mission…" and "Start over…" for one mission, wherever it is shown. Hidden when the
 * mission is finished, or the viewer cannot give the unit orders; a withdrawn mission can only
 * be started over.
 */
@Component({
  selector: 'orb-mission-course',
  imports: [Icon],
  template: `
    @if (auth.can(unitId())) {
      @if (status() !== 'done' && status() !== 'withdrawn') {
        <button type="button" class="btn btn--ghost" (click)="open('abort-mission')">
          <orb-icon class="sm" name="x" /> Abort mission…
        </button>
      }
      @if (status() !== 'done') {
        <button type="button" class="btn btn--ghost" (click)="open('restart-mission')">
          <orb-icon class="sm" name="undo" /> Start over…
        </button>
      }
    }
  `,
  host: { class: 'mission-course' },
  styles: `
    :host {
      display: inline-flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
  `,
})
export class MissionCourse {
  readonly missionId = input.required<string>();
  readonly goal = input.required<string>();
  readonly status = input.required<MissionStatus>();
  readonly unitId = input.required<string>();
  readonly unitName = input<string | null>(null);
  readonly inOperation = input(false);
  readonly changed = output<void>();
  protected readonly auth = inject(Auth);
  private readonly dialog = inject(Dialog);
  private readonly toasts = inject(Toasts);

  protected open(kind: 'abort-mission' | 'restart-mission'): void {
    const data: CourseData = {
      kind,
      id: this.missionId(),
      label: this.goal(),
      unitName: this.unitName(),
      inOperation: this.inOperation(),
    };
    openDialog<boolean, CourseData, CourseDialog>(
      this.dialog,
      CourseDialog,
      data,
      COPY[kind].title(data),
    ).closed.subscribe((done) => {
      if (!done) return;
      this.toasts.show({ tone: 'info', message: COPY[kind].done });
      this.changed.emit();
    });
  }
}

/** "Start over…" in an operation's header: every mission issued again from the same plan. */
@Component({
  selector: 'orb-restart-operation',
  imports: [Icon],
  template: `
    <button type="button" class="btn" (click)="open()">
      <orb-icon name="undo" />
      Start over…
    </button>
  `,
  host: { style: 'display: contents' },
})
export class RestartOperationButton {
  readonly operationId = input.required<string>();
  readonly name = input.required<string>();
  readonly restarted = output<void>();
  private readonly dialog = inject(Dialog);
  private readonly toasts = inject(Toasts);

  protected open(): void {
    const data: CourseData = {
      kind: 'restart-operation',
      id: this.operationId(),
      label: this.name(),
      unitName: null,
      inOperation: true,
    };
    openDialog<boolean, CourseData, CourseDialog>(
      this.dialog,
      CourseDialog,
      data,
      COPY['restart-operation'].title(data),
    ).closed.subscribe((done) => {
      if (!done) return;
      this.toasts.show({ tone: 'info', message: `Operation ${this.name()} started over.` });
      this.restarted.emit();
    });
  }
}
