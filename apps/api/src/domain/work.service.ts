import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CreateTaskRequest,
  type MissionBody,
  type OperationBody,
  type TaskBody,
} from '@orbot/shared';
import type { z } from 'zod';
import { RecordService, type WriteContext } from '../record/record.service.js';

/** Operations, missions and tasks. Every piece of work belongs to exactly one unit or bot. */
@Injectable()
export class WorkService {
  constructor(private readonly record: RecordService) {}

  createOperation(body: OperationBody, ctx: WriteContext, id?: string) {
    return this.record.create('operation', body, ctx, id);
  }

  listOperations() {
    return this.record.listActive('operation');
  }

  createMission(body: MissionBody, ctx: WriteContext, id?: string) {
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
    if (input.repoSupplyId) {
      const s = await this.record.requireActive('supply', input.repoSupplyId);
      if (s.body.spec.kind !== 'repository' || !s.body.connected) {
        throw new BadRequestException(
          'The chosen supply is not a connected repository. Connect it in the Supply Depot first.',
        );
      }
    }
    const number = await this.record.nextTaskNumber();
    const body: TaskBody = {
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
    };
    return this.record.transaction(async (w) => {
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
    });
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
