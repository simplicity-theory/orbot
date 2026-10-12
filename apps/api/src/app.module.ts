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
import { PolicyService } from './policy/policy.service.js';
import { RecordBus } from './record/record-bus.js';
import { RecordController } from './record/record.controller.js';
import { RecordService } from './record/record.service.js';
import { LOG_DESTINATION, RedactingLogger } from './redaction/redacting-logger.js';
import { RedactionInterceptor } from './redaction/redaction.interceptor.js';
import { RedactionService } from './redaction/redaction.service.js';
import { RuntimeRegistry } from './runtime/runtime.registry.js';
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
        MetaController,
        AuthController,
        DomainController,
        RecordController,
        SupplyController,
        OverseerController,
        ChatController,
        SettingsController,
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
        {
          provide: RuntimeRegistry,
          useFactory: () => {
            const r = new RuntimeRegistry();
            r.register(new SimulatedRuntime());
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
        ActionsService,
        ChatService,
        EventsGateway,
        { provide: APP_GUARD, useClass: AuthGuard },
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
