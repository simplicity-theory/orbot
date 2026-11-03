import { Authority, unitOf } from '../officers/authority.js';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  CancelOperationRequest,
  CourseNoteRequest,
  CreateOperationRequest,
  DeployDecisionRequest,
  OperationHoldPolicyRequest,
  OperationResourceRequest,
  PermissionDecisionRequest,
  SetBudgetRequest,
} from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView } from '../domain/view.js';
import { ViewsService } from '../domain/views.service.js';
import { HoldPolicyService } from '../policy/hold-policy.service.js';
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
    private readonly holds: HoldPolicyService,
  ) {}

  /** Override what holds this operation's work (null: back to each unit's own). The Commander's alone. */
  @Put('operations/:id/hold-policy')
  async holdPolicy(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(OperationHoldPolicyRequest))
    body: z.output<typeof OperationHoldPolicyRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.holds.setOperation(id, body.policy, { actor, reason: body.reason }));
  }

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
        body.supplyIds ?? [],
        { theatreId: body.theatreId ?? null },
      ),
    );
  }

  /**
   * Assign a depot item to the operation. While it waits at the O Group for resources, HQ
   * checks again and carries on once it has what it needs. The Commander's alone (as in chat).
   */
  @Post('operations/:id/resources')
  @HttpCode(200)
  async assignResource(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(OperationResourceRequest)) body: z.output<typeof OperationResourceRequest>,
    @Actor() actor: string,
  ) {
    await this.hq.assignResource(id, body.supplyId, actor, body.reason);
    return this.views.operation(id);
  }

  /** Take a depot item off the operation (units that hold it keep it). */
  @Post('operations/:id/resources/release')
  @HttpCode(200)
  async releaseResource(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(OperationResourceRequest)) body: z.output<typeof OperationResourceRequest>,
    @Actor() actor: string,
  ) {
    await this.hq.releaseResource(id, body.supplyId, actor, body.reason);
    return this.views.operation(id);
  }

  /**
   * Make a repository the operation's main one. Once missions are out they are withdrawn and
   * issued again there (the work done stays on record).
   */
  @Post('operations/:id/resources/main')
  @HttpCode(200)
  async setMainRepository(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(OperationResourceRequest)) body: z.output<typeof OperationResourceRequest>,
    @Actor() actor: string,
  ) {
    await this.hq.setMainRepository(id, body.supplyId, actor, body.reason);
    return this.views.operation(id);
  }

  /** Call the operation off: its work stands down and it closes without a review. */
  @Post('operations/:id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(CancelOperationRequest)) body: z.output<typeof CancelOperationRequest>,
    @Actor() actor: string,
  ) {
    await this.hq.cancelOperation(id, body.note, actor);
    return this.views.operation(id);
  }

  /** Start the operation over: every mission withdrawn and issued again from the same plan. */
  @Post('operations/:id/restart')
  @HttpCode(200)
  async restart(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(CourseNoteRequest)) body: z.output<typeof CourseNoteRequest>,
    @Actor() actor: string,
  ) {
    await this.hq.restartOperation(id, body.note, actor);
    return this.views.operation(id);
  }

  /** Abort one mission: its work stands down and it is withdrawn; the operation waits for a decision. */
  @Post('missions/:id/abort')
  @HttpCode(200)
  async abortMission(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(CourseNoteRequest)) body: z.output<typeof CourseNoteRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.hq.abortMission(id, body.note, actor));
  }

  /** Start one mission over: withdrawn and issued again to its unit, which briefs back afresh. Returns the new mission. */
  @Post('missions/:id/restart')
  @HttpCode(200)
  async restartMission(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(CourseNoteRequest)) body: z.output<typeof CourseNoteRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.hq.restartMission(id, body.note, actor));
  }

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

  /** Land a task's branch on its repository's default branch. The Commander's alone. */
  @Post('tasks/:id/land')
  @HttpCode(200)
  land(@Param('id', Uuid) id: string, @Actor() actor: string) {
    return this.hq.landTask(id, actor);
  }

  /** Compute spent so far by unit, operation and task: the baseline for deciding limits (D114). */
  @Authority({ level: 'read' })
  @Get('compute')
  usage() {
    return this.budgets.usage();
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

  /** Approve (or refuse) what a bot asked permission for under its rules of engagement. */
  @Authority({ level: 'unit', units: unitOf('task', 'param') })
  @Post('tasks/:id/permission-decision')
  @HttpCode(200)
  async decidePermission(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(PermissionDecisionRequest))
    body: z.output<typeof PermissionDecisionRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.overseer.decidePermission(id, body.approve, body.note, actor));
  }
}
