import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CreateDocumentRequest, CreateTaskRequest, ReviseDocumentRequest } from '@orbot/shared';
import { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TaskRunner } from '../execution/task-runner.js';
import { DocumentsService } from './documents.service.js';
import { ForceService } from './force.service.js';
import { toView, toViews } from './view.js';
import { ViewsService } from './views.service.js';
import { WorkService } from './work.service.js';

const Uuid = new ParseUUIDPipe({ version: undefined });
const TaskFilter = z.object({
  unitId: z.uuid().optional(),
  botId: z.uuid().optional(),
  missionId: z.uuid().optional(),
});

@Controller()
export class DomainController {
  constructor(
    private readonly views: ViewsService,
    private readonly force: ForceService,
    private readonly work: WorkService,
    private readonly documents: DocumentsService,
    private readonly runner: TaskRunner,
  ) {}

  @Get('orbat')
  orbat() {
    return this.views.orbat();
  }

  @Get('units')
  async units() {
    return toViews(await this.force.listUnits());
  }

  @Get('units/:id')
  unit(@Param('id', Uuid) id: string) {
    return this.views.unit(id);
  }

  @Get('bots/:id')
  bot(@Param('id', Uuid) id: string) {
    return this.views.bot(id);
  }

  @Get('operations')
  async operations() {
    return toViews(await this.work.listOperations());
  }

  @Get('tasks')
  async tasks(@Query(new ZodPipe(TaskFilter)) q: z.infer<typeof TaskFilter>) {
    return toViews(await this.work.listTasks(q));
  }

  @Get('tasks/:id')
  task(@Param('id', Uuid) id: string) {
    return this.views.task(id);
  }

  @Post('tasks')
  async createTask(
    @Body(new ZodPipe(CreateTaskRequest)) body: z.output<typeof CreateTaskRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.work.createTask(body, { actor, reason: 'Task created' }));
  }

  /** Starts the task in the background; progress arrives over the WebSocket and in the record. */
  @Post('tasks/:id/run')
  @HttpCode(202)
  async runTask(@Param('id', Uuid) id: string, @Actor() actor: string) {
    const h = await this.runner.start(id, actor);
    return { runId: h.runId, taskId: h.taskId };
  }

  @Get('documents')
  async listDocuments(@Query('unitId') unitId?: string) {
    return toViews(await this.documents.list(unitId ? { unitId } : {}));
  }

  @Get('documents/:id')
  async document(@Param('id', Uuid) id: string) {
    return toView(await this.documents.get(id));
  }

  @Post('documents')
  async createDocument(
    @Body(new ZodPipe(CreateDocumentRequest)) body: z.output<typeof CreateDocumentRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.documents.create(body, { actor, reason: 'Document created' }));
  }

  /** A rewrite: inserts a new version and archives the old one. */
  @Post('documents/:id/versions')
  async reviseDocument(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(ReviseDocumentRequest)) body: z.output<typeof ReviseDocumentRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.documents.revise(id, body, actor));
  }
}
