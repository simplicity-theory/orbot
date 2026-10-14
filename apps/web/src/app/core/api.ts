import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AppointOfficerRequest,
  ConnectServiceRequest,
  MeView,
  OfficerView,
  UpdateOfficerRequest,
  MainEffortView,
  ReconRequest,
  StandDownRequest,
  StandDownView,
  ChatSendResult,
  OrdersLogEntryView,
  RecordEvent as ChatRecordEvent,
  SettingsBody,
  SupplyView,
  AddBotRequest,
  AmendBackbriefRequest,
  ApprovalsView,
  BackbriefView,
  BotView,
  CreateFmEntryRequest,
  CreateMissionRequest,
  FmEntryView,
  MissionView,
  OperationView,
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
  operations: () => `${API}/operations`,
  operation: (id: string) => `${API}/operations/${id}`,
  chat: (channel: string) => `${API}/chat/${channel}`,
  orders: () => `${API}/orders`,
  supply: () => `${API}/supply`,
  settings: () => `${API}/settings`,
  standDown: () => `${API}/stand-down`,
  mainEffort: () => `${API}/main-effort`,
  dailyBrief: () => `${API}/daily-brief`,
  officers: () => `${API}/officers`,
  connections: () => `${API}/connections`,
  issues: (connectionId: string) => `${API}/connections/${connectionId}/issues`,
  serviceRecord: (botId: string) => `${API}/bots/${botId}/service-record`,
  alerts: () => `${API}/alerts`,
  secrets: () => `${API}/supply/secrets`,
  deconfliction: () => `${API}/deconfliction`,
  disputes: () => `${API}/disputes`,
};

export type SettingsView = SettingsBody & { version: number; actionKinds: string[] };

export type {
  ChatSendResult,
  OrdersLogEntryView,
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

  login(passphrase: string, login?: string) {
    return firstValueFrom(
      this.http.post<{ principal: Principal }>(`${API}/auth/login`, {
        passphrase,
        ...(login ? { login } : {}),
      }),
    );
  }

  logout() {
    return firstValueFrom(this.http.post<void>(`${API}/auth/logout`, {}));
  }

  me() {
    return firstValueFrom(this.http.get<MeView>(apiUrl.me()));
  }

  appointOfficer(req: AppointOfficerRequest) {
    return firstValueFrom(this.http.post<OfficerView>(`${API}/officers`, req));
  }

  updateOfficer(id: string, req: UpdateOfficerRequest) {
    return firstValueFrom(this.http.put<OfficerView>(`${API}/officers/${id}`, req));
  }

  setOfficerPassword(id: string, password: string) {
    return firstValueFrom(this.http.post<void>(`${API}/officers/${id}/password`, { password }));
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

  sendChat(channel: string, text: string) {
    return firstValueFrom(this.http.post<ChatSendResult>(apiUrl.chat(channel), { text }));
  }

  confirmPending(id: string, phrase?: string) {
    return firstValueFrom(
      this.http.post<ChatRecordEvent<'chat.readback'>>(
        `${API}/pending/${id}/confirm`,
        phrase ? { phrase } : {},
      ),
    );
  }

  declinePending(id: string) {
    return firstValueFrom(this.http.post<unknown>(`${API}/pending/${id}/decline`, {}));
  }

  undoOrder(id: string) {
    return firstValueFrom(this.http.post<{ summary: string }>(`${API}/orders/${id}/undo`, {}));
  }

  connectRepository(name: string, location: string) {
    return firstValueFrom(
      this.http.post<SupplyView>(`${API}/supply/repositories`, { name, location }),
    );
  }

  storeCredential(name: string, value: string) {
    return firstValueFrom(this.http.post<SupplyView>(`${API}/supply/credentials`, { name, value }));
  }

  connectEnvironment(name: string, tier: 'staging' | 'production') {
    return firstValueFrom(this.http.post<SupplyView>(`${API}/supply/environments`, { name, tier }));
  }

  allotSupply(supplyId: string, unitId: string, revoke = false) {
    return firstValueFrom(
      this.http.post<unknown>(`${API}/supply/allot`, { supplyId, unitId, revoke }),
    );
  }

  updateSettings(body: {
    irreversibleActions?: string[];
    confirmationPhrase?: string;
    budgetWarnAt?: number;
    mainEffortYield?: boolean;
    dailyBrief?: { enabled: boolean; at: string; timeZone: string };
    alerts?: { enabled: boolean; credentialName: string | null; kinds: string[] };
    escalation?: {
      stallSeconds: number;
      timeoutSeconds: number;
      repeatedFailures: number;
      failingBotRuns: number;
    };
    reason: string;
    expectedVersion: number;
  }) {
    return firstValueFrom(this.http.put<SettingsView>(apiUrl.settings(), body));
  }

  createOperation(intent: string, name?: string, budgetUnits?: number | null, reconFirst = false) {
    return firstValueFrom(
      this.http.post<OperationView>(`${API}/operations`, {
        intent,
        ...(name ? { name } : {}),
        ...(budgetUnits ? { budgetUnits } : {}),
        ...(reconFirst ? { reconFirst } : {}),
      }),
    );
  }

  /** Set a unit's (0 = none) or an operation's (null = none) compute budget cap. */
  setBudget(scope: 'unit' | 'operation', id: string, units: number | null, reason: string) {
    return firstValueFrom(
      this.http.put<unknown>(`${API}/${scope === 'unit' ? 'units' : 'operations'}/${id}/budget`, {
        units,
        reason,
      }),
    );
  }

  decideDeploy(taskId: string, approve: boolean, note: string | null = null) {
    return firstValueFrom(
      this.http.post<TaskView>(`${API}/tasks/${taskId}/deploy-decision`, { approve, note }),
    );
  }

  ruleDispute(id: string, prevails: 'raiser' | 'other', reasoning: string) {
    return firstValueFrom(
      this.http.post<unknown>(`${API}/disputes/${id}/rule`, { prevails, reasoning }),
    );
  }

  resolveEscalation(chainId: string, note: string) {
    return firstValueFrom(
      this.http.post<unknown>(`${API}/escalations/${chainId}/resolve`, { note }),
    );
  }

  writeDailyBrief() {
    return firstValueFrom(this.http.post<unknown>(`${API}/daily-brief`, {}));
  }

  testAlert() {
    return firstValueFrom(
      this.http.post<{ body: { delivered: boolean; error: string | null } }>(
        `${API}/alerts/test`,
        {},
      ),
    );
  }

  connectService(req: ConnectServiceRequest) {
    return firstValueFrom(this.http.post<SupplyView>(`${API}/supply/connections`, req));
  }

  disconnectService(id: string) {
    return firstValueFrom(
      this.http.post<SupplyView>(`${API}/supply/connections/${id}/disconnect`, {}),
    );
  }

  takeIssue(connectionId: string, unitId: string, number: number) {
    return firstValueFrom(
      this.http.post<MissionView>(`${API}/connections/${connectionId}/issues/take`, {
        unitId,
        number,
      }),
    );
  }

  openPullRequest(taskId: string) {
    return firstValueFrom(this.http.post<TaskView>(`${API}/tasks/${taskId}/pull-request`, {}));
  }

  pollPipelines() {
    return firstValueFrom(this.http.post<void>(`${API}/connections/poll`, {}));
  }

  /** Rehearse an operation's plan on the sand table. */
  rehearse(operationId: string) {
    return firstValueFrom(
      this.http.post<unknown>(`${API}/operations/${operationId}/sand-table`, {}),
    );
  }

  /** Send a unit on recon (a read-only survey that files a report). */
  recon(req: ReconRequest) {
    return firstValueFrom(this.http.post<TaskView>(`${API}/recon`, req));
  }

  /** Name the main effort (an operation), or clear it with null. */
  setMainEffort(operationId: string | null, reason: string) {
    return firstValueFrom(
      this.http.put<MainEffortView>(`${API}/main-effort`, { operationId, reason }),
    );
  }

  /** Give a stand-down order (`lift: false`) or lift one. */
  standDown(req: StandDownRequest, lift = false) {
    return firstValueFrom(
      this.http.post<StandDownView>(`${API}/stand-down${lift ? '/lift' : ''}`, req),
    );
  }

  setAllBotsRuntime(runtime: string, reason: string) {
    return firstValueFrom(
      this.http.put<{ switched: number }>(`${API}/bots/runtime`, { runtime, reason }),
    );
  }

  setBotRuntime(botId: string, runtime: string, reason: string) {
    return firstValueFrom(
      this.http.put<BotView>(`${API}/bots/${botId}/runtime`, { runtime, reason }),
    );
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
