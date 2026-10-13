import { Authority, unitOf } from '../officers/authority.js';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { CreateOperationRequest, DeployDecisionRequest, SetBudgetRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { ViewsService } from '../domain/views.service.js';
import { SandTableService } from './sand-table.service.js';
import { BudgetService } from './budget.service.js';
import { HqService } from './hq.service.js';
import { OverseerService } from './overseer.service.js';

const Uuid = new ParseUUIDPipe();

/** Operations: from the Commander's intent, through HQ, across the units. */
@Controller()
export class OperationsController {
  constructor(
    private readonly hq: HqService,
    private readonly overseer: OverseerService,
    private readonly views: ViewsService,
    private readonly budgets: BudgetService,
    private readonly sandTables: SandTableService,
  ) {}

  @Get('operations')
  list() {
    return this.views.operations();
  }

  @Get('operations/:id')
  detail(@Param('id', Uuid) id: string) {
    return this.views.operation(id);
  }

  @Post('operations')
  async create(
    @Body(new ZodPipe(CreateOperationRequest)) body: z.output<typeof CreateOperationRequest>,
    @Actor() actor: string,
  ) {
    return toView(
      await this.hq.createOperation(
        body.intent,
        body.name ?? null,
        actor,
        body.budgetUnits ?? null,
        body.reconFirst ?? false,
      ),
    );
  }

  /** Set the operation's compute budget cap (null = none); work held at the old cap resumes. */
  /** Rehearse the plan on the sand table (changes nothing; the result is kept). */
  @Authority({ level: 'officer' })
  @Post('operations/:id/sand-table')
  async rehearse(@Param('id', Uuid) id: string, @Actor() actor: string) {
    await this.sandTables.rehearse(id, actor);
    return this.views.operation(id);
  }

  @Put('operations/:id/budget')
  async budget(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(SetBudgetRequest)) body: z.output<typeof SetBudgetRequest>,
    @Actor() actor: string,
  ) {
    await this.budgets.setOperationCap(id, body.units, body.reason, actor);
    return this.views.operation(id);
  }

  /** Set a unit's compute budget cap (0 = none); work held at the old cap resumes. */
  @Put('units/:id/budget')
  async unitBudget(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(SetBudgetRequest)) body: z.output<typeof SetBudgetRequest>,
    @Actor() actor: string,
  ) {
    await this.budgets.setUnitCap(id, body.units, body.reason, actor);
    return this.budgets.unitBudget(id);
  }

  /** Approve (or reject) a production deploy waiting on the Commander. */
  @Authority({ level: 'unit', units: unitOf('task', 'param') })
  @Post('tasks/:id/deploy-decision')
  @HttpCode(200)
  async decide(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(DeployDecisionRequest)) body: z.output<typeof DeployDecisionRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.overseer.decideDeploy(id, body.approve, body.note, actor));
  }
}
