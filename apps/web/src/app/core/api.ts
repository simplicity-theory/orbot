import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AddBotRequest,
  AmendBackbriefRequest,
  ApprovalsView,
  BackbriefView,
  BotView,
  CreateFmEntryRequest,
  CreateMissionRequest,
  FmEntryView,
  MissionView,
  PaletteItem,
  RecordEvent as RecordEventOf,
  ReviseFmEntryRequest,
  StandingOrdersRequest,
  UnitView as UnitViewOf,
  BotDetailView,
  CreateDocumentRequest,
  CreateTaskRequest,
  DocumentView,
  MetaView,
  OrbatView,
  Principal,
  RecordEvent,
  ReviseDocumentRequest,
  SearchHit,
  SearchScope,
  TaskDetailView,
  TaskView,
  UnitDetailView,
  UnitView,
  VersionDiff,
  VersionWithStatus,
} from '@orbot/shared';

export const API = '/api';

/** URL builders for httpResource-based pages, so paths live in one place. */
export const apiUrl = {
  meta: () => `${API}/meta`,
  me: () => `${API}/auth/me`,
  orbat: () => `${API}/orbat`,
  units: () => `${API}/units`,
  unit: (id: string) => `${API}/units/${id}`,
  bot: (id: string) => `${API}/bots/${id}`,
  task: (id: string) => `${API}/tasks/${id}`,
  document: (id: string) => `${API}/documents/${id}`,
  history: (entityId: string) => `${API}/record/${entityId}/history`,
  asOf: (entityId: string) => `${API}/record/${entityId}/as-of`,
  diff: (entityId: string) => `${API}/record/${entityId}/diff`,
  search: () => `${API}/record/search`,
  events: () => `${API}/record/events`,
  approvals: () => `${API}/approvals`,
  backbrief: (id: string) => `${API}/backbriefs/${id}`,
  palette: () => `${API}/palette`,
};

export type {
  ApprovalsView,
  BackbriefView,
  FmEntryView,
  PaletteItem,
  BotDetailView,
  DocumentView,
  MetaView,
  OrbatView,
  RecordEvent,
  SearchHit,
  TaskDetailView,
  TaskView,
  UnitDetailView,
  UnitView,
  VersionDiff,
  VersionWithStatus,
};

/** Imperative API calls (commands). Queries use httpResource with `apiUrl`. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  login(passphrase: string) {
    return firstValueFrom(
      this.http.post<{ principal: Principal }>(`${API}/auth/login`, { passphrase }),
    );
  }

  logout() {
    return firstValueFrom(this.http.post<void>(`${API}/auth/logout`, {}));
  }

  me() {
    return firstValueFrom(this.http.get<{ principal: Principal }>(apiUrl.me()));
  }

  meta() {
    return firstValueFrom(this.http.get<MetaView>(apiUrl.meta()));
  }

  createTask(body: CreateTaskRequest) {
    return firstValueFrom(this.http.post<TaskView>(`${API}/tasks`, body));
  }

  runTask(id: string) {
    return firstValueFrom(
      this.http.post<{ runId: string; taskId: string }>(`${API}/tasks/${id}/run`, {}),
    );
  }

  createDocument(body: CreateDocumentRequest) {
    return firstValueFrom(this.http.post<DocumentView>(`${API}/documents`, body));
  }

  reviseDocument(id: string, body: ReviseDocumentRequest) {
    return firstValueFrom(this.http.post<DocumentView>(`${API}/documents/${id}/versions`, body));
  }

  createMission(body: CreateMissionRequest) {
    return firstValueFrom(this.http.post<MissionView>(`${API}/missions`, body));
  }

  approveBackbrief(id: string, expectedVersion: number, note: string | null = null) {
    return firstValueFrom(
      this.http.post<BackbriefView>(`${API}/backbriefs/${id}/approve`, { expectedVersion, note }),
    );
  }

  amendBackbrief(id: string, body: AmendBackbriefRequest) {
    return firstValueFrom(this.http.post<BackbriefView>(`${API}/backbriefs/${id}/amend`, body));
  }

  rejectBackbrief(id: string, expectedVersion: number, note: string) {
    return firstValueFrom(
      this.http.post<BackbriefView>(`${API}/backbriefs/${id}/reject`, { expectedVersion, note }),
    );
  }

  reassignTask(id: string, botId: string, reason: string) {
    return firstValueFrom(
      this.http.post<TaskView>(`${API}/tasks/${id}/reassign`, { botId, reason }),
    );
  }

  addBot(unitId: string, body: AddBotRequest) {
    return firstValueFrom(this.http.post<BotView>(`${API}/units/${unitId}/bots`, body));
  }

  runColdStart(unitId: string) {
    return firstValueFrom(
      this.http.post<RecordEventOf<'coldstart.check'>>(`${API}/units/${unitId}/coldstart`, {}),
    );
  }

  syncDocuments(unitId: string) {
    return firstValueFrom(
      this.http.post<{ imported: string[] }>(`${API}/units/${unitId}/documents/sync`, {}),
    );
  }

  setStandingOrders(unitId: string, body: StandingOrdersRequest) {
    return firstValueFrom(
      this.http.put<UnitViewOf>(`${API}/units/${unitId}/standing-orders`, body),
    );
  }

  createFmEntry(unitId: string, body: CreateFmEntryRequest) {
    return firstValueFrom(this.http.post<FmEntryView>(`${API}/units/${unitId}/field-manual`, body));
  }

  reviseFmEntry(id: string, body: ReviseFmEntryRequest) {
    return firstValueFrom(this.http.post<FmEntryView>(`${API}/fm-entries/${id}/versions`, body));
  }

  retireFmEntry(id: string, expectedVersion: number, reason: string) {
    return firstValueFrom(
      this.http.post<FmEntryView>(`${API}/fm-entries/${id}/retire`, { expectedVersion, reason }),
    );
  }

  reinstateFmEntry(id: string, expectedVersion: number, reason: string) {
    return firstValueFrom(
      this.http.post<FmEntryView>(`${API}/fm-entries/${id}/reinstate`, { expectedVersion, reason }),
    );
  }

  unitView(id: string) {
    return firstValueFrom(this.http.get<UnitDetailView>(apiUrl.unit(id)));
  }

  palette() {
    return firstValueFrom(this.http.get<PaletteItem[]>(apiUrl.palette()));
  }

  search(q: string, scope: SearchScope, extra: { types?: string[]; unitId?: string } = {}) {
    const params: Record<string, string> = { q, scope };
    if (extra.types?.length) params['types'] = extra.types.join(',');
    if (extra.unitId) params['unitId'] = extra.unitId;
    return firstValueFrom(this.http.get<SearchHit[]>(apiUrl.search(), { params }));
  }
}
