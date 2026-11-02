import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { CodeService } from './code.service.js';

const Uuid = new ParseUUIDPipe({ version: undefined });

/** The code bots wrote: repository history, commits with their diffs, a task's changes. */
@Controller()
export class CodeController {
  constructor(private readonly code: CodeService) {}

  @Get('repositories/:id/history')
  history(@Param('id', Uuid) id: string, @Query('ref') ref?: string) {
    return this.code.history(id, ref || undefined);
  }

  @Get('repositories/:id/commits/:sha')
  commit(@Param('id', Uuid) id: string, @Param('sha') sha: string) {
    return this.code.commit(id, sha);
  }

  /** A commit by id alone: found in whichever repository has it. */
  @Get('commits/:sha')
  find(@Param('sha') sha: string) {
    return this.code.findCommit(sha);
  }

  @Get('tasks/:id/changes')
  taskChanges(@Param('id', Uuid) id: string) {
    return this.code.taskChanges(id);
  }
}
