import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
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
};

export type {
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

  search(q: string, scope: SearchScope, extra: { types?: string[]; unitId?: string } = {}) {
    const params: Record<string, string> = { q, scope };
    if (extra.types?.length) params['types'] = extra.types.join(',');
    if (extra.unitId) params['unitId'] = extra.unitId;
    return firstValueFrom(this.http.get<SearchHit[]>(apiUrl.search(), { params }));
  }
}
