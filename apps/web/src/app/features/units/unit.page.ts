import { Can } from '../../ui/can';
import { Dialog } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { MissionStatus, OperationDetailView, Status, UnitDetailView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive, touchedIds } from '../../core/live';
import { PageTitle } from '../../core/title';
import { Backbrief } from '../../ui/backbrief';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { fullDate, RelativeTimePipe } from '../../ui/relative-time';
import { Skeleton } from '../../ui/skeleton';
import { BudgetControl } from '../../ui/budget';
import { UrlPipe } from '../../ui/url.pipe';
import { StandDownButton } from '../../ui/stand-down';
import { MainEfforts } from '../../core/main-effort';
import { MainEffortBadge } from '../../ui/main-effort';
import { StatusBadge } from '../../ui/status-badge';
import { Term } from '../../ui/term';
import { RecordTimeline } from '../tasks/record-timeline';
import { AddBotDialog, type AddBotData } from './add-bot.dialog';
import { ColdStartCard } from './coldstart-card';
import { FieldManualTab } from './field-manual-tab';
import { NewMissionDialog, type NewMissionData } from './new-mission.dialog';
import { ReconDialog, type ReconData } from './recon.dialog';
import { RulesTab } from './rules-tab';
import { MissionCourse } from '../operations/mission-course';

export const UNIT_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'field-manual', label: 'Field Manual', term: 'field-manual' },
  { id: 'war-diary', label: 'War Diary', term: 'war-diary' },
  { id: 'handovers', label: 'Handovers', term: 'handover' },
  { id: 'recon', label: 'Recon', term: 'recon' },
  { id: 'rules', label: 'Rules' },
  { id: 'supply', label: 'Supply', term: 'supply' },
] as const;
export type UnitSection = (typeof UNIT_SECTIONS)[number]['id'];

@Component({
  selector: 'orb-unit-page',
  imports: [
    Can,
    MainEffortBadge,
    RouterLink,
    StatusBadge,
    StandDownButton,
    BudgetControl,
    UrlPipe,
    Skeleton,
    LoadError,
    Term,
    Icon,
    RelativeTimePipe,
    Backbrief,
    ColdStartCard,
    FieldManualTab,
    RulesTab,
    MissionCourse,
    RecordTimeline,
  ],
  templateUrl: './unit.page.html',
  styleUrl: './unit.page.scss',
})
export class UnitPage {
  protected readonly efforts = inject(MainEfforts);
  readonly unitId = input.required<string>();
  /** `?section=` — every section is deep-linkable. */
  readonly section = input<UnitSection, string | undefined>('overview', {
    transform: (v) => (UNIT_SECTIONS.some((s) => s.id === v) ? (v as UnitSection) : 'overview'),
  });
  /** `?mission=` — opened from an operation: that mission, singled out. */
  readonly mission = input<string>();
  protected readonly sections = UNIT_SECTIONS;
  protected readonly view = httpResource<UnitDetailView>(() => apiUrl.unit(this.unitId()));
  protected readonly full = fullDate;
  private readonly dialog = inject(Dialog);

  protected readonly activeMissions = computed(
    () =>
      this.view
        .value()
        ?.missions.filter((m) => m.mission.status !== 'done' && m.mission.status !== 'withdrawn') ??
      [],
  );
  protected readonly doneMissions = computed(
    () => this.view.value()?.missions.filter((m) => m.mission.status === 'done') ?? [],
  );
  protected readonly focus = computed(() => {
    const v = this.view.value();
    const m = v?.missions.find((x) => x.mission.id === this.mission());
    return m && v ? { ...m, tasks: v.tasks.filter((t) => t.missionId === m.mission.id) } : null;
  });
  private readonly focusOperation = httpResource<OperationDetailView>(() => {
    const id = this.focus()?.mission.operationId;
    return id ? apiUrl.operation(id) : undefined;
  });
  protected readonly focusOperationName = computed(
    () => this.focusOperation.value()?.operation.name ?? null,
  );
  protected readonly workers = computed(
    () => this.view.value()?.bots.filter((b) => !b.isOverseer && b.status !== 'stood-down') ?? [],
  );

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      const section = UNIT_SECTIONS.find((s) => s.id === this.section())!;
      crumbs.set([
        ORBAT_CRUMB,
        section.id === 'overview'
          ? { label: v.unit.name }
          : { label: v.unit.name, link: `/units/${v.unit.id}` },
        ...(section.id === 'overview' ? [] : [{ label: section.label }]),
      ]);
      title.set(section.id === 'overview' ? v.unit.name : `${section.label} · ${v.unit.name}`);
    });
    reloadOnLive(
      (n) => touchedIds(n).includes(this.unitId()),
      () => this.view.reload(),
    );
  }

  protected newMission(): void {
    const v = this.view.value()!;
    openDialog<boolean, NewMissionData, NewMissionDialog>(
      this.dialog,
      NewMissionDialog,
      { unitId: v.unit.id, unitName: v.unit.name },
      'New mission',
    );
  }

  protected reconReports() {
    return (this.view.value()?.documents ?? []).filter((d) => d.kind === 'recon');
  }

  protected orderRecon(): void {
    const v = this.view.value()!;
    openDialog<boolean, ReconData, ReconDialog>(
      this.dialog,
      ReconDialog,
      {
        unitId: v.unit.id,
        unitName: v.unit.name,
        repositories: v.supply
          .filter((s) => s.spec.kind === 'repository' && s.connected)
          .map((s) => ({ id: s.id, name: s.name })),
      },
      'Recon',
    );
  }

  protected addBot(replacesBotId: string | null = null): void {
    const v = this.view.value()!;
    openDialog<unknown, AddBotData, AddBotDialog>(
      this.dialog,
      AddBotDialog,
      { unitId: v.unit.id, unitName: v.unit.name, bots: this.workers(), replacesBotId },
      replacesBotId ? 'Replace a bot' : 'Add a bot',
    ).closed.subscribe(() => this.view.reload());
  }

  /** Missions share the app's one status vocabulary. */
  protected missionStatus(s: MissionStatus): Status {
    return s === 'planning' || s === 'waiting' ? 'queued' : s === 'withdrawn' ? 'stood-down' : s;
  }

  protected callsign(v: UnitDetailView, botId: string | null): string {
    return v.bots.find((b) => b.id === botId)?.callsign ?? '';
  }

  protected percent(done: number, total: number): number {
    return total ? Math.round((done / total) * 100) : 0;
  }
}
