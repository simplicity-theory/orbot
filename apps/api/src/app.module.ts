import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { DestinationStream } from 'pino';
import type pg from 'pg';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { ErrorFilter } from './common/error.filter.js';
import { MetaController } from './common/meta.controller.js';
import { createPool, createRecordDb, RECORD_DB, RECORD_POOL } from './db/database.js';
import { PoolCloser } from './db/pool-closer.js';
import { DocumentsService } from './domain/documents.service.js';
import { DomainController } from './domain/domain.controller.js';
import { ForceService } from './domain/force.service.js';
import { ViewsService } from './domain/views.service.js';
import { WorkService } from './domain/work.service.js';
import { TaskRunner } from './execution/task-runner.js';
import { EventsGateway } from './gateway/events.gateway.js';
import { DutiesService } from './policy/duties.service.js';
import { PolicyService } from './policy/policy.service.js';
import { RecordBus } from './record/record-bus.js';
import { RecordController } from './record/record.controller.js';
import { RecordService } from './record/record.service.js';
import { LOG_DESTINATION, RedactingLogger } from './redaction/redacting-logger.js';
import { RedactionInterceptor } from './redaction/redaction.interceptor.js';
import { RedactionService } from './redaction/redaction.service.js';
import { RuntimeRegistry } from './runtime/runtime.registry.js';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeRuntime } from './runtime/claude.runtime.js';
import {
  EnvironmentsController,
  ModelsController,
  ServersController,
} from './servers/servers.controller.js';
import { AppsService } from './servers/apps.service.js';
import { HealthService } from './servers/health.service.js';
import { CodeController } from './code/code.controller.js';
import { CodeService } from './code/code.service.js';
import { ServersService } from './servers/servers.service.js';
import { SshClient } from './servers/ssh.client.js';
import { ClaudeCodeRuntime } from './runtime/claude-code.runtime.js';
import { SimulatedRuntime } from './runtime/simulated.runtime.js';
import { WorkspaceManager } from './runtime/workspace-manager.js';
import { createSecretsPool, SECRETS_POOL, SecretsService } from './secrets/secrets.service.js';
import { SupplyController } from './supply/supply.controller.js';
import { SupplyService } from './supply/supply.service.js';
import { Background } from './common/background.js';
import { FieldManualService } from './documents/field-manual.service.js';
import {
  createDocumentStore,
  UNIT_DOCUMENT_STORE,
  UnitDocsService,
} from './documents/unit-docs.service.js';
import { BriefingService } from './overseer/briefing.service.js';
import { ColdStartService } from './overseer/coldstart.service.js';
import { CurationService } from './overseer/curation.service.js';
import { OverseerController } from './overseer/overseer.controller.js';
import { OverseerService } from './overseer/overseer.service.js';
import { Overseers } from './overseer/overseers.js';
import { HqService } from './overseer/hq.service.js';
import { OperationsController } from './overseer/operations.controller.js';
import { MainEffortController } from './overseer/main-effort.controller.js';
import { ReconController } from './overseer/recon.controller.js';
import { ReconService } from './overseer/recon.service.js';
import { SandTableService } from './overseer/sand-table.service.js';
import { ServiceRecordService } from './domain/service-record.service.js';
import { AuthorityGuard, AuthorityService } from './officers/authority.js';
import { OfficersController } from './officers/officers.controller.js';
import { OfficersService } from './officers/officers.service.js';
import { ConnectionsController } from './connections/connections.controller.js';
import { ConnectionsService } from './connections/connections.service.js';
import { AlertService } from './overseer/alert.service.js';
import { DailyBriefController } from './overseer/daily-brief.controller.js';
import { DailyBriefService } from './overseer/daily-brief.service.js';
import { MainEffortService } from './overseer/main-effort.service.js';
import { StandDownController } from './overseer/stand-down.controller.js';
import { StandDownService } from './overseer/stand-down.service.js';
import { BudgetService } from './overseer/budget.service.js';
import { EscalationController } from './overseer/escalation.controller.js';
import { DeconflictionController } from './overseer/deconfliction.controller.js';
import { DisputeController } from './overseer/dispute.controller.js';
import { DisputeService } from './overseer/dispute.service.js';
import { DeconflictionService } from './overseer/deconfliction.service.js';
import { EscalationService } from './overseer/escalation.service.js';
import { ActionsService } from './chat/actions.service.js';
import { ChatController } from './chat/chat.controller.js';
import { ChatService } from './chat/chat.service.js';
import { SettingsController } from './settings/settings.controller.js';
import { SettingsService } from './settings/settings.service.js';

export interface AppModuleOptions {
  config: AppConfig;
  /** Where log lines go (tests capture them). Defaults to stdout. */
  logDestination?: DestinationStream;
}

@Module({})
export class AppModule {
  static forRoot(opts: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(opts.config)],
      controllers: [
        CodeController,
        MetaController,
        AuthController,
        DomainController,
        RecordController,
        SupplyController,
        OverseerController,
        ChatController,
        SettingsController,
        OperationsController,
        StandDownController,
        MainEffortController,
        ReconController,
        ConnectionsController,
        OfficersController,
        DailyBriefController,
        EscalationController,
        DeconflictionController,
        DisputeController,
        ServersController,
        ModelsController,
        EnvironmentsController,
      ],
      providers: [
        { provide: LOG_DESTINATION, useValue: opts.logDestination ?? null },
        RedactionService,
        RedactingLogger,
        {
          provide: RECORD_POOL,
          inject: [APP_CONFIG],
          useFactory: (c: AppConfig) => createPool(c.recordDb.app),
        },
        {
          provide: RECORD_DB,
          inject: [RECORD_POOL],
          useFactory: (p: pg.Pool) => createRecordDb(p),
        },
        { provide: SECRETS_POOL, inject: [APP_CONFIG], useFactory: createSecretsPool },
        RecordBus,
        RecordService,
        SecretsService,
        PolicyService,
        DutiesService,
        {
          provide: RuntimeRegistry,
          inject: [APP_CONFIG],
          useFactory: (c: AppConfig) => {
            const r = new RuntimeRegistry();
            r.register(new SimulatedRuntime());
            // The Claude runtime is available when an API key is configured.
            if (c.anthropicApiKey) {
              r.register(
                new ClaudeRuntime(new Anthropic({ apiKey: c.anthropicApiKey }), {
                  model: c.claudeModel,
                }),
              );
            }
            // Claude Code on the Commander's own Claude plan, when turned on.
            if (c.claudeCode) {
              r.register(
                new ClaudeCodeRuntime({
                  model: c.claudeModel,
                  executable: c.claudeCodePath || undefined,
                }),
              );
            }
            return r;
          },
        },
        WorkspaceManager,
        TaskRunner,
        ForceService,
        WorkService,
        DocumentsService,
        SupplyService,
        ViewsService,
        Background,
        FieldManualService,
        { provide: UNIT_DOCUMENT_STORE, inject: [APP_CONFIG], useFactory: createDocumentStore },
        UnitDocsService,
        Overseers,
        BriefingService,
        CurationService,
        ColdStartService,
        OverseerService,
        SettingsService,
        HqService,
        StandDownService,
        MainEffortService,
        ReconService,
        SandTableService,
        ConnectionsService,
        OfficersService,
        AuthorityService,
        ServiceRecordService,
        DailyBriefService,
        SshClient,
        ServersService,
        AppsService,
        HealthService,
        CodeService,
        AlertService,
        BudgetService,
        EscalationService,
        DeconflictionService,
        DisputeService,
        ActionsService,
        ChatService,
        EventsGateway,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: AuthorityGuard },
        { provide: APP_INTERCEPTOR, useClass: RedactionInterceptor },
        { provide: APP_FILTER, useClass: ErrorFilter },
        PoolCloser,
      ],
      exports: [
        RecordService,
        SecretsService,
        TaskRunner,
        RuntimeRegistry,
        RedactingLogger,
        Background,
      ],
    };
  }
}
