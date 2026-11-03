import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ConnectServiceRequest, GitHubTheatreRequest, TakeIssueRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { Authority, unitOf } from '../officers/authority.js';
import { ViewsService } from '../domain/views.service.js';
import { ConnectionsService } from './connections.service.js';

const Uuid = new ParseUUIDPipe();

/** Code host, issue tracker and build pipeline connections. Connecting is the Commander's. */
@Controller()
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly views: ViewsService,
  ) {}

  /** Put a theatre's repository on GitHub: made there if need be, main pushed, every landing after. */
  @Post('theatres/:id/github')
  @HttpCode(200)
  async github(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(GitHubTheatreRequest)) body: z.output<typeof GitHubTheatreRequest>,
    @Actor() actor: string,
  ) {
    await this.connections.putTheatreOnGitHub(id, body, actor);
    return this.views.theatre(id);
  }

  @Get('connections')
  list() {
    return this.connections.view();
  }

  @Post('supply/connections')
  async connect(
    @Body(new ZodPipe(ConnectServiceRequest)) body: z.output<typeof ConnectServiceRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.connections.connect(body, actor));
  }

  @Post('supply/connections/:id/disconnect')
  @HttpCode(200)
  async disconnect(@Param('id', Uuid) id: string, @Actor() actor: string) {
    return toView(await this.connections.disconnect(id, actor));
  }

  @Get('connections/:id/issues')
  issues(@Param('id', Uuid) id: string) {
    return this.connections.issues(id);
  }

  @Post('connections/:id/issues/take')
  @Authority({ level: 'unit', units: unitOf('unit', 'body') })
  async take(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(TakeIssueRequest)) body: z.output<typeof TakeIssueRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.connections.takeIssue(id, body.unitId, body.number, actor));
  }

  /** Push a task's branch and open a pull request for it. */
  @Post('tasks/:id/pull-request')
  @HttpCode(200)
  @Authority({ level: 'unit', units: unitOf('task', 'param') })
  async pullRequest(@Param('id', Uuid) id: string, @Actor() actor: string) {
    return toView(await this.connections.publishTask(id, actor));
  }

  /** Check pending pipelines now (they are also checked on a timer). */
  @Post('connections/poll')
  @HttpCode(204)
  @Authority({ level: 'officer' })
  async poll() {
    await this.connections.pollPipelines();
  }
}
