import { BadRequestException, Injectable } from '@nestjs/common';
import { CreateTaskRequest, type EntityInputMap, type TaskBody } from '@orbot/shared';
import type { z } from 'zod';
import { RecordService, type RecordWriter, type WriteContext } from '../record/record.service.js';

/** Operations, missions and tasks. Every piece of work belongs to exactly one unit or bot. */
@Injectable()
export class WorkService {
  constructor(private readonly record: RecordService) {}

  createOperation(body: EntityInputMap['operation'], ctx: WriteContext, id?: string) {
    return this.record.create('operation', body, ctx, id);
  }

  listOperations() {
    return this.record.listActive('operation');
  }

  createMission(body: EntityInputMap['mission'], ctx: WriteContext, id?: string) {
    return this.record.create('mission', body, ctx, id);
  }

  listMissions(filter: { unitId?: string; operationId?: string } = {}) {
    return this.record.listActive('mission', {
      ...(filter.unitId ? { unitId: filter.unitId } : {}),
      ...(filter.operationId ? { bodyContains: { operationId: filter.operationId } } : {}),
    });
  }

  async createTask(input: z.output<typeof CreateTaskRequest>, ctx: WriteContext, id?: string) {
    await this.record.requireActive('unit', input.unitId);
    if (input.botId) {
      const bot = await this.record.requireActive('bot', input.botId);
      if (bot.body.unitId !== input.unitId) {
        throw new BadRequestException(
          'That bot belongs to a different unit. Pick a bot from the same unit.',
        );
      }
    }
    if (input.missionId) {
      const m = await this.record.requireActive('mission', input.missionId);
      if (m.body.unitId !== input.unitId) {
        throw new BadRequestException('That mission is owned by a different unit.');
      }
    }
    if (input.continuesTaskId) {
      const prev = await this.record.requireActive('task', input.continuesTaskId);
      if (prev.body.unitId !== input.unitId) {
        throw new BadRequestException('A task can only continue work from its own unit.');
      }
    }
    if (input.repoSupplyId) {
      const s = await this.record.requireActive('supply', input.repoSupplyId);
      if (s.body.spec.kind !== 'repository' || !s.body.connected) {
        throw new BadRequestException(
          'The chosen supply is not a connected repository. Connect it in the Supply Depot first.',
        );
      }
    }
    const number = await this.record.nextTaskNumber();
    return this.record.transaction((w) => this.writeTask(w, number, input, ctx, id));
  }

  /** Create a task (and queue it on its bot) inside an existing transaction. */
  async writeTask(
    w: RecordWriter,
    number: number,
    input: z.output<typeof CreateTaskRequest> & {
      autoStart?: boolean;
      kind?: TaskBody['kind'];
      baseRef?: string | null;
      approval?: TaskBody['approval'];
    },
    ctx: WriteContext,
    id?: string,
  ) {
    const body: EntityInputMap['task'] = {
      number,
      title: input.title,
      description: input.description,
      unitId: input.unitId,
      missionId: input.missionId,
      botId: input.botId,
      status: 'queued',
      budget: { limitUnits: input.budgetLimitUnits, spentUnits: 0 },
      repoSupplyId: input.repoSupplyId,
      workspace: null,
      credentialNames: input.credentialNames,
      scenario: input.scenario,
      statusReason: null,
      continuesTaskId: input.continuesTaskId ?? null,
      autoStart: input.autoStart ?? false,
      kind: input.kind ?? 'work',
      baseRef: input.baseRef ?? null,
      approval: input.approval ?? null,
    };
    const task = await w.create('task', body, ctx, id);
    await w.event(
      'task.assigned',
      { taskNumber: number, title: input.title },
      {
        unitId: input.unitId,
        botId: input.botId,
        taskId: task.entityId,
        missionId: input.missionId,
      },
      ctx.actor,
    );
    if (input.botId) {
      await w.revise('bot', input.botId, (b) => ({ ...b, queue: [...b.queue, task.entityId] }), {
        actor: ctx.actor,
        reason: `Task #${number} queued`,
      });
    }
    return task;
  }

  getTask(id: string) {
    return this.record.requireActive('task', id);
  }

  listTasks(filter: { unitId?: string; botId?: string; missionId?: string } = {}) {
    const bodyContains: Partial<TaskBody> = {};
    if (filter.botId) bodyContains.botId = filter.botId;
    if (filter.missionId) bodyContains.missionId = filter.missionId;
    return this.record.listActive('task', {
      ...(filter.unitId ? { unitId: filter.unitId } : {}),
      ...(Object.keys(bodyContains).length ? { bodyContains } : {}),
    });
  }
}
