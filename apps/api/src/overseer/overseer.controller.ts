import { Authority, unitOf } from '../officers/authority.js';
import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  AddBotRequest,
  AmendBackbriefRequest,
  ApproveBackbriefRequest,
  CreateFmEntryRequest,
  CreateMissionRequest,
  ReassignTaskRequest,
  RejectBackbriefRequest,
  RetireFmEntryRequest,
  ReviseFmEntryRequest,
  HoldPolicyRequest,
  StandingOrdersRequest,
  type SourceRef,
} from '@orbot/shared';
import { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { FieldManualService } from '../documents/field-manual.service.js';
import { UnitDocsService } from '../documents/unit-docs.service.js';
import { toView } from '../domain/view.js';
import { ViewsService } from '../domain/views.service.js';
import { RecordService } from '../record/record.service.js';
import { SupplyService } from '../supply/supply.service.js';
import { HoldPolicyService } from '../policy/hold-policy.service.js';
import { RuntimeRegistry } from '../runtime/runtime.registry.js';
import { ColdStartService } from './coldstart.service.js';
import { OverseerService } from './overseer.service.js';

const Uuid = new ParseUUIDPipe();
const AllotSupply = z.object({ supplyId: z.uuid() });
const SetRuntime = z.object({
  runtime: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});
const commanderSource = (actor: string): SourceRef => ({
  kind: 'commander',
  id: null,
  version: null,
  label: `Commander (${actor})`,
});

/** Commanding a unit: missions, backbriefs, bots, and the unit's documents. */
@Controller()
export class OverseerController {
  constructor(
    private readonly overseer: OverseerService,
    private readonly views: ViewsService,
    private readonly record: RecordService,
    private readonly fieldManual: FieldManualService,
    private readonly docs: UnitDocsService,
    private readonly coldStart: ColdStartService,
    private readonly supply: SupplyService,
    private readonly runtimes: RuntimeRegistry,
    private readonly holds: HoldPolicyService,
  ) {}

  /** Restart the queues: stranded tasks queued again, every unit dispatched. The Commander's alone. */
  @Post('queues/restart')
  @HttpCode(200)
  restartQueues(@Actor() actor: string) {
    return this.overseer.restartQueues(actor);
  }

  @Authority({ level: 'unit', units: unitOf('unit', 'body') })
  @Post('missions')
  async createMission(
    @Body(new ZodPipe(CreateMissionRequest)) body: z.output<typeof CreateMissionRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.overseer.createMission(body, actor));
  }

  @Get('approvals')
  approvals() {
    return this.views.approvals();
  }

  @Get('backbriefs/:id')
  backbrief(@Param('id', Uuid) id: string) {
    return this.views.backbrief(id);
  }

  @Authority({ level: 'unit', units: unitOf('backbrief', 'param') })
  @Post('backbriefs/:id/approve')
  @HttpCode(200)
  async approve(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(ApproveBackbriefRequest)) body: z.output<typeof ApproveBackbriefRequest>,
    @Actor() actor: string,
  ) {
    await this.overseer.approve(id, body, actor);
    return this.views.backbrief(id);
  }

  @Authority({ level: 'unit', units: unitOf('backbrief', 'param') })
  @Post('backbriefs/:id/amend')
  @HttpCode(200)
  async amend(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(AmendBackbriefRequest)) body: z.output<typeof AmendBackbriefRequest>,
    @Actor() actor: string,
  ) {
    await this.overseer.amend(id, body, actor);
    return this.views.backbrief(id);
  }

  @Authority({ level: 'unit', units: unitOf('backbrief', 'param') })
  @Post('backbriefs/:id/reject')
  @HttpCode(200)
  async reject(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(RejectBackbriefRequest)) body: z.output<typeof RejectBackbriefRequest>,
    @Actor() actor: string,
  ) {
    await this.overseer.reject(id, body, actor);
    return this.views.backbrief(id);
  }

  @Authority({ level: 'unit', units: unitOf('task', 'param') })
  @Post('tasks/:id/reassign')
  @HttpCode(200)
  async reassign(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(ReassignTaskRequest)) body: z.output<typeof ReassignTaskRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.overseer.reassign(id, body, actor));
  }

  @Authority({ level: 'unit', units: unitOf('unit', 'param') })
  @Post('units/:id/bots')
  async addBot(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(AddBotRequest)) body: z.output<typeof AddBotRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.overseer.addBot(id, body, actor));
  }

  @Post('units/:id/supply')
  @HttpCode(200)
  async allot(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(AllotSupply)) body: z.infer<typeof AllotSupply>,
    @Actor() actor: string,
  ) {
    return toView(
      await this.supply.allotToUnit(body.supplyId, id, {
        actor,
        reason: 'Supply issued to the unit',
      }),
    );
  }

  @Authority({ level: 'unit', units: unitOf('unit', 'param') })
  @Post('units/:id/coldstart')
  @HttpCode(200)
  runColdStart(@Param('id', Uuid) id: string) {
    return this.coldStart.check(id);
  }

  /** Import edits humans made to the unit's Markdown files in the repository. */
  @Authority({ level: 'unit', units: unitOf('unit', 'param') })
  @Post('units/:id/documents/sync')
  @HttpCode(200)
  async sync(@Param('id', Uuid) id: string) {
    return { imported: await this.docs.sync(id) };
  }

  /** What holds the unit's work for the Commander. The Commander's alone. */
  @Put('units/:id/hold-policy')
  async holdPolicy(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(HoldPolicyRequest)) body: z.output<typeof HoldPolicyRequest>,
    @Actor() actor: string,
  ) {
    return toView(await this.holds.setUnit(id, body.policy, { actor, reason: body.reason }));
  }

  @Authority({ level: 'unit', units: unitOf('unit', 'param') })
  @Put('units/:id/standing-orders')
  async standingOrders(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(StandingOrdersRequest)) body: z.output<typeof StandingOrdersRequest>,
    @Actor() actor: string,
  ) {
    const orders = body.orders.map((o) => ({
      id: o.id ?? `so-${randomUUID().slice(0, 8)}`,
      text: o.text,
    }));
    return toView(
      await this.record.revise('unit', id, (u) => ({ ...u, standingOrders: orders }), {
        actor,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
      }),
    );
  }

  @Authority({ level: 'unit', units: unitOf('unit', 'param') })
  @Post('units/:id/field-manual')
  async createEntry(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(CreateFmEntryRequest)) body: z.output<typeof CreateFmEntryRequest>,
    @Actor() actor: string,
  ) {
    await this.record.requireActive('unit', id);
    const entry = await this.record.transaction(async (w) => {
      const e = await this.fieldManual.promote(
        w,
        id,
        { title: body.title, body: body.body, tags: body.tags, pinned: body.pinned },
        commanderSource(actor),
        { actor, reason: body.reason },
      );
      await this.fieldManual.rerender(w, id, { actor, reason: body.reason });
      return e;
    });
    return toView(entry);
  }

  @Authority({ level: 'unit', units: unitOf('fm-entry', 'param') })
  @Post('fm-entries/:id/versions')
  async reviseEntry(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(ReviseFmEntryRequest)) body: z.output<typeof ReviseFmEntryRequest>,
    @Actor() actor: string,
  ) {
    const current = await this.record.requireActive('fm-entry', id);
    const entry = await this.record.transaction(async (w) => {
      const e = await this.fieldManual.edit(w, id, body, commanderSource(actor), {
        actor,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
      });
      await this.fieldManual.rerender(w, current.body.unitId, { actor, reason: body.reason });
      return e!;
    });
    return toView(entry);
  }

  @Authority({ level: 'unit', units: unitOf('fm-entry', 'param') })
  @Post('fm-entries/:id/retire')
  @HttpCode(200)
  async retireEntry(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(RetireFmEntryRequest)) body: z.output<typeof RetireFmEntryRequest>,
    @Actor() actor: string,
  ) {
    const current = await this.record.requireActive('fm-entry', id);
    const entry = await this.record.transaction(async (w) => {
      const e = await this.fieldManual.retire(w, id, {
        actor,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
      });
      await this.fieldManual.rerender(w, current.body.unitId, {
        actor,
        reason: `Retired “${current.body.title}”: ${body.reason}`,
      });
      return e!;
    });
    return toView(entry);
  }

  @Authority({ level: 'unit', units: unitOf('fm-entry', 'param') })
  @Post('fm-entries/:id/reinstate')
  @HttpCode(200)
  async reinstateEntry(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(RetireFmEntryRequest)) body: z.output<typeof RetireFmEntryRequest>,
    @Actor() actor: string,
  ) {
    const current = await this.record.requireActive('fm-entry', id);
    const entry = await this.record.transaction(async (w) => {
      const e = await this.fieldManual.reinstate(w, id, {
        actor,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
      });
      await this.fieldManual.rerender(w, current.body.unitId, {
        actor,
        reason: `Reinstated “${current.body.title}”: ${body.reason}`,
      });
      return e!;
    });
    return toView(entry);
  }

  /** Switch every bot in the force to one runtime (e.g. onto the Commander's Claude plan). */
  @Put('bots/runtime')
  async setRuntimeForAll(
    @Body(new ZodPipe(SetRuntime)) body: z.infer<typeof SetRuntime>,
    @Actor() actor: string,
  ): Promise<{ switched: number }> {
    this.runtimes.get(body.runtime);
    const bots = (await this.record.listActive('bot')).filter(
      (b) => b.body.runtime !== body.runtime,
    );
    await this.record.transaction(async (w) => {
      for (const b of bots) {
        await w.revise('bot', b.entityId, (x) => ({ ...x, runtime: body.runtime }), {
          actor,
          reason: body.reason,
        });
      }
    });
    return { switched: bots.length };
  }

  /** Switch which runtime drives a bot (e.g. from simulated to Claude). */
  @Authority({ level: 'unit', units: unitOf('bot', 'param') })
  @Put('bots/:id/runtime')
  async setRuntime(
    @Param('id', Uuid) id: string,
    @Body(new ZodPipe(SetRuntime)) body: z.infer<typeof SetRuntime>,
    @Actor() actor: string,
  ) {
    this.runtimes.get(body.runtime);
    return toView(
      await this.record.revise('bot', id, (b) => ({ ...b, runtime: body.runtime }), {
        actor,
        reason: body.reason,
      }),
    );
  }

  @Get('palette')
  palette() {
    return this.views.palette();
  }
}
