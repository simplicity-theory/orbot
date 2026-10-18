import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ConnectServerRequest,
  InstallAppRequest,
  type AppProgressView,
  type ModelCheckView,
  type ServerDetailView,
} from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { RecordService } from '../record/record.service.js';
import { AppsService } from './apps.service.js';
import { ServersService } from './servers.service.js';

/** Servers bots log in to, and the apps on them. Changing them is the Commander's (like all supply). */
@Controller('supply/servers')
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly apps: AppsService,
    private readonly record: RecordService,
  ) {}

  @Post()
  async connect(
    @Body(new ZodPipe(ConnectServerRequest)) body: z.output<typeof ConnectServerRequest>,
    @Actor() actor: string,
  ) {
    return toView(
      await this.servers.connect(body, {
        actor,
        reason: `Server ${body.name} (${body.user}@${body.host}) connected`,
      }),
    );
  }

  /** The server's page: the server, what happened on it, and the apps that can be installed. */
  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<ServerDetailView> {
    const s = await this.servers.require(id);
    const events = await this.record.findEvents(
      ['app.install', 'server.command', 'server.workspace'],
      { supplyId: id },
      { latest: true, limit: 100 },
    );
    return {
      supply: toView(s),
      events: events as ServerDetailView['events'],
      catalog: await this.apps.catalog(),
    };
  }

  /** Log in again with the stored key, and refresh what the server is. */
  @Post(':id/check')
  @HttpCode(200)
  check(@Param('id', new ParseUUIDPipe()) id: string, @Actor() actor: string) {
    return this.servers.check(id, actor);
  }

  /** A login without sudo for bots' dev work. */
  @Post(':id/workspace')
  @HttpCode(200)
  async workspace(@Param('id', new ParseUUIDPipe()) id: string, @Actor() actor: string) {
    return toView(
      await this.servers.setupWorkspace(id, {
        actor,
        reason: 'Bot workspace set up on the server',
      }),
    );
  }

  @Post(':id/apps')
  async install(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(InstallAppRequest)) body: z.output<typeof InstallAppRequest>,
    @Actor() actor: string,
  ) {
    return toView(
      await this.apps.install(id, body, { actor, reason: `Install ${body.app} on the server` }),
    );
  }

  /** Live: the install's state and log on the server (redacted). */
  @Get(':id/apps/:appId/progress')
  progress(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('appId', new ParseUUIDPipe()) appId: string,
  ): Promise<AppProgressView> {
    return this.apps.progress(id, appId);
  }

  @Post(':id/apps/:appId/status')
  @HttpCode(200)
  async status(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('appId', new ParseUUIDPipe()) appId: string,
    @Actor() actor: string,
  ) {
    return toView(
      await this.apps.status(id, appId, { actor, reason: 'Status read from the server' }),
    );
  }

  @Post(':id/apps/:appId/uninstall')
  @HttpCode(200)
  async uninstall(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('appId', new ParseUUIDPipe()) appId: string,
    @Actor() actor: string,
  ) {
    return toView(
      await this.apps.uninstall(id, appId, { actor, reason: 'Remove the app from the server' }),
    );
  }
}

/** Models bots can be given. */
@Controller('supply/models')
export class ModelsController {
  constructor(private readonly apps: AppsService) {}

  /** Ask the endpoint which models it serves (with its key, used by name). */
  @Post(':id/check')
  @HttpCode(200)
  check(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Actor() actor: string,
  ): Promise<ModelCheckView> {
    return this.apps.checkModel(id, actor);
  }
}
