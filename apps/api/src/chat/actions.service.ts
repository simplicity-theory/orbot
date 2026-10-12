import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { ChatAction, ChatLink, TaskBody, TaskStatus } from '@orbot/shared';
import { TaskRunner } from '../execution/task-runner.js';
import { HqService } from '../overseer/hq.service.js';
import { StandDownService } from '../overseer/stand-down.service.js';
import { OverseerService } from '../overseer/overseer.service.js';
import { RecordService, type WriteContext } from '../record/record.service.js';
import { SupplyService } from '../supply/supply.service.js';

export interface ActionResult {
  summary: string;
  links: ChatLink[];
  /** The action that reverses this one, or null if it cannot be undone. */
  inverse: ChatAction | null;
  /** Words describing what changed, used to find live work it affects. */
  affects: string[];
}

const unitLink = (unitId: string, section?: string) =>
  `/units/${unitId}${section ? `?section=${section}` : ''}`;
const taskLink = (t: { unitId: string; botId: string | null }, id: string) =>
  t.botId ? `/units/${t.unitId}/bots/${t.botId}/tasks/${id}` : `/units/${t.unitId}/tasks/${id}`;

/**
 * Carries out chat actions through the same services the UI uses. Chat has no
 * side doors: every change here is one the Commander could also make by hand.
 */
@Injectable()
export class ActionsService {
  constructor(
    private readonly record: RecordService,
    private readonly overseer: OverseerService,
    private readonly supply: SupplyService,
    private readonly runner: TaskRunner,
    private readonly hq: HqService,
    private readonly standDowns: StandDownService,
  ) {}

  async run(action: ChatAction, ctx: WriteContext): Promise<ActionResult> {
    if (action.kind === 'create-operation') {
      const op = await this.hq.createOperation(action.intent, action.name, ctx.actor);
      return {
        summary: `Operation ${op.body.name} launched: HQ is holding the O Group and will issue missions to the units.`,
        links: [{ label: `Operation ${op.body.name}`, link: `/operations/${op.entityId}` }],
        inverse: null,
        affects: [],
      };
    }
    if (action.kind === 'stand-down' || action.kind === 'lift-stand-down') {
      const target = { scope: action.scope, targetId: action.targetId };
      const inverse: ChatAction = {
        ...action,
        kind: action.kind === 'stand-down' ? 'lift-stand-down' : 'stand-down',
        reason: `Undo: ${action.reason}`,
      };
      const link =
        action.scope === 'all'
          ? '/'
          : action.scope === 'unit'
            ? unitLink(action.targetId!)
            : `/units/${(await this.record.requireActive('bot', action.targetId!)).body.unitId}/bots/${action.targetId}`;
      if (action.kind === 'stand-down') {
        const r = await this.standDowns.standDown(target, action.reason, ctx.actor);
        return {
          summary: `${r.label} stood down: ${action.reason}.${
            r.pausedTaskIds.length
              ? ` ${r.pausedTaskIds.length} running task(s) paused with a handover.`
              : ' Nothing was running.'
          }`,
          links: [{ label: r.label, link }],
          inverse,
          affects: [],
        };
      }
      const r = await this.standDowns.lift(target, action.reason, ctx.actor);
      return {
        summary: `${r.label}: stand-down lifted. ${
          r.resumedTaskIds.length
            ? `${r.resumedTaskIds.length} paused task(s) back in the queue.`
            : 'No paused work to pick up.'
        }`,
        links: [{ label: r.label, link }],
        inverse,
        affects: [],
      };
    }
    const unit = await this.record.requireActive('unit', action.unitId);
    const u = unit.body.name;
    switch (action.kind) {
      case 'create-mission': {
        const m = await this.overseer.createMission(
          { unitId: action.unitId, goal: action.goal, definitionOfDone: action.definitionOfDone },
          ctx.actor,
        );
        return {
          summary: `New mission for ${u}: “${action.goal}”. The Overseer will brief back a plan.`,
          links: [{ label: action.goal, link: unitLink(action.unitId) }],
          inverse: {
            kind: 'withdraw-mission',
            unitId: action.unitId,
            missionId: m.entityId,
            note: 'Undo of a chat order',
          },
          affects: [],
        };
      }
      case 'withdraw-mission': {
        const mission = await this.record.requireActive('mission', action.missionId);
        const tasks = await this.record.listActive('task', {
          bodyContains: { missionId: action.missionId },
        });
        const [bb] = await this.record.listActive('backbrief', {
          bodyContains: { missionId: action.missionId },
        });
        const live = tasks.filter((t) => ['queued', 'working', 'blocked'].includes(t.body.status));
        for (const t of live)
          await this.standDown(t.entityId, t.body, `Mission withdrawn: ${action.note}`, ctx);
        await this.record.transaction(async (w) => {
          if (bb?.body.status === 'awaiting-approval') {
            await w.revise(
              'backbrief',
              bb.entityId,
              (b) => ({
                ...b,
                status: 'rejected',
                decision: {
                  outcome: 'rejected',
                  by: ctx.actor,
                  note: 'Mission withdrawn',
                  at: new Date().toISOString(),
                },
              }),
              ctx,
            );
          }
          await w.revise('mission', action.missionId, (m) => ({ ...m, status: 'withdrawn' }), ctx);
        });
        return {
          summary: `Withdrew the mission “${mission.body.goal}” from ${u}${live.length ? `; stood down ${live.length} task(s)` : ''}.`,
          links: [{ label: mission.body.goal, link: unitLink(action.unitId) }],
          inverse: null,
          affects: [],
        };
      }
      case 'frago': {
        const tasks = await Promise.all(
          action.taskIds.map((id) => this.record.requireActive('task', id)),
        );
        for (const t of tasks) {
          if (t.body.unitId !== action.unitId)
            throw new BadRequestException(`Task #${t.body.number} is not ${u}'s.`);
          if (action.change === 'stand-down') {
            await this.standDown(t.entityId, t.body, `Frago: ${action.note}`, ctx);
          } else {
            await this.record.revise(
              'task',
              t.entityId,
              (b) => ({ ...b, description: `${b.description}\n\nFrago: ${action.note}`.trim() }),
              ctx,
            );
            await this.runner.frago(t.entityId, action.note, null, ctx.actor);
          }
        }
        const names = tasks.map((t) => `#${t.body.number} ${t.body.title}`).join(', ');
        return {
          summary:
            action.change === 'stand-down'
              ? `Frago to ${u}: stood down ${names} (it can be resumed).`
              : `Frago to ${u}: amended ${names} — “${action.note}”`,
          links: tasks.map((t) => ({
            label: `Task #${t.body.number}`,
            link: taskLink(t.body, t.entityId),
          })),
          inverse:
            action.change === 'stand-down'
              ? {
                  kind: 'resume',
                  unitId: action.unitId,
                  taskIds: action.taskIds,
                  note: 'Undo of a frago',
                }
              : null,
          affects: [],
        };
      }
      case 'resume': {
        const tasks = await Promise.all(
          action.taskIds.map((id) => this.record.requireActive('task', id)),
        );
        for (const t of tasks) await this.resume(t.entityId, t.body, action.note, ctx);
        return {
          summary: `Resumed ${tasks.map((t) => `#${t.body.number} ${t.body.title}`).join(', ')} in ${u}.`,
          links: tasks.map((t) => ({
            label: `Task #${t.body.number}`,
            link: taskLink(t.body, t.entityId),
          })),
          inverse: {
            kind: 'frago',
            unitId: action.unitId,
            change: 'stand-down',
            taskIds: action.taskIds,
            note: 'Undo of a resume',
          },
          affects: [],
        };
      }
      case 'rule-change': {
        const removed = unit.body.standingOrders.filter((o) => action.removeOrders.includes(o.id));
        const added = action.addOrders.map((text) => ({
          id: `so-${randomUUID().slice(0, 8)}`,
          text,
        }));
        await this.record.revise(
          'unit',
          action.unitId,
          (b) => ({
            ...b,
            standingOrders: [
              ...b.standingOrders.filter((o) => !action.removeOrders.includes(o.id)),
              ...added,
            ],
            rulesOfEngagement: {
              mayDoAlone: [
                ...b.rulesOfEngagement.mayDoAlone.filter(
                  (r) => !action.removeRoe.some((x) => x.list === 'mayDoAlone' && x.text === r),
                ),
                ...action.addRoe.filter((x) => x.list === 'mayDoAlone').map((x) => x.text),
              ],
              mustEscalate: [
                ...b.rulesOfEngagement.mustEscalate.filter(
                  (r) => !action.removeRoe.some((x) => x.list === 'mustEscalate' && x.text === r),
                ),
                ...action.addRoe.filter((x) => x.list === 'mustEscalate').map((x) => x.text),
              ],
            },
          }),
          ctx,
        );
        const parts = [
          ...removed.map((o) => `dropped “${o.text}”`),
          ...added.map((o) => `added “${o.text}”`),
          ...action.removeRoe.map((r) => `dropped ROE “${r.text}”`),
          ...action.addRoe.map((r) => `added ROE “${r.text}”`),
        ];
        return {
          summary: `${u} standing orders: ${parts.join('; ')}`,
          links: [{ label: `${u} rules`, link: unitLink(action.unitId, 'rules') }],
          inverse: {
            kind: 'rule-change',
            unitId: action.unitId,
            removeOrders: added.map((o) => o.id),
            addOrders: removed.map((o) => o.text),
            removeRoe: action.addRoe,
            addRoe: action.removeRoe,
          },
          affects: [...removed.map((o) => o.text), ...added.map((o) => o.text)],
        };
      }
      case 'supply-grant':
      case 'grant-deploy-rights': {
        const s = await this.record.requireActive('supply', action.supplyId);
        if (!s.body.connected)
          throw new BadRequestException(`${s.body.name} is not connected in the Supply Depot.`);
        await this.supply.allotToUnit(action.supplyId, action.unitId, ctx);
        const deploy = action.kind === 'grant-deploy-rights';
        return {
          summary: deploy
            ? `${u} now has deploy rights to ${s.body.name}.`
            : `${s.body.name} (${s.body.spec.kind}) issued to ${u}.`,
          links: [
            { label: s.body.name, link: '/supply' },
            { label: `${u} supply`, link: unitLink(action.unitId, 'supply') },
          ],
          inverse: deploy
            ? null
            : { kind: 'supply-revoke', unitId: action.unitId, supplyId: action.supplyId },
          affects: [s.body.name, s.body.name.replace(/[-_]/g, ' '), s.body.spec.kind],
        };
      }
      case 'supply-revoke': {
        const s = await this.record.requireActive('supply', action.supplyId);
        await this.supply.revokeFromUnit(action.supplyId, action.unitId, ctx);
        return {
          summary: `${s.body.name} withdrawn from ${u}.`,
          links: [{ label: `${u} supply`, link: unitLink(action.unitId, 'supply') }],
          inverse: { kind: 'supply-grant', unitId: action.unitId, supplyId: action.supplyId },
          affects: [],
        };
      }
      case 'approve-deploy': {
        const t = await this.overseer.decideDeploy(
          action.taskId,
          action.approve,
          'Given in chat',
          ctx.actor,
        );
        return {
          summary: action.approve
            ? `Production deploy approved for task #${t.body.number} (${u}).`
            : `Production deploy rejected for task #${t.body.number} (${u}).`,
          links: [{ label: `Task #${t.body.number}`, link: taskLink(t.body, t.entityId) }],
          inverse: null,
          affects: [],
        };
      }
      case 'budget-grant': {
        const next = await this.record.revise(
          'unit',
          action.unitId,
          (b) => ({ ...b, computeBudget: Math.max(0, (b.computeBudget ?? 0) + action.units) }),
          ctx,
        );
        return {
          summary: `${u} compute budget ${action.units >= 0 ? 'raised' : 'lowered'} by ${Math.abs(action.units)} to ${next.body.computeBudget} units.`,
          links: [{ label: `${u}`, link: unitLink(action.unitId) }],
          inverse: { kind: 'budget-grant', unitId: action.unitId, units: -action.units },
          affects: ['budget'],
        };
      }
    }
  }

  private async standDown(taskId: string, task: TaskBody, reason: string, ctx: WriteContext) {
    if (this.runner.isRunning(taskId)) {
      this.runner.stop(taskId, reason);
      return;
    }
    if (!(['queued', 'blocked', 'failed'] as TaskStatus[]).includes(task.status)) return;
    await this.record.transaction(async (w) => {
      await w.revise(
        'task',
        taskId,
        (t) => ({ ...t, status: 'stood-down', statusReason: reason }),
        ctx,
      );
      await w.event(
        'task.status',
        { from: task.status, to: 'stood-down', reason },
        { unitId: task.unitId, botId: task.botId, taskId, missionId: task.missionId },
        ctx.actor,
      );
      if (task.botId) {
        const bot = await w.getActive('bot', task.botId);
        if (bot?.body.currentTaskId === taskId) {
          await w.revise(
            'bot',
            task.botId,
            (b) => ({ ...b, status: 'idle', currentTaskId: null }),
            ctx,
          );
        }
      }
    });
  }

  private async resume(taskId: string, task: TaskBody, note: string, ctx: WriteContext) {
    if (task.status !== 'stood-down') return;
    await this.record.transaction(async (w) => {
      await w.revise(
        'task',
        taskId,
        (t) => ({ ...t, status: 'queued', statusReason: `Resumed: ${note}` }),
        ctx,
      );
      await w.event(
        'task.status',
        { from: 'stood-down', to: 'queued', reason: `Resumed: ${note}` },
        { unitId: task.unitId, botId: task.botId, taskId, missionId: task.missionId },
        ctx.actor,
      );
      if (task.botId) {
        await w.revise(
          'bot',
          task.botId,
          (b) => (b.queue.includes(taskId) ? b : { ...b, queue: [...b.queue, taskId] }),
          ctx,
        );
      }
    });
    // Overseer-issued work is picked up by the dispatcher; work the Commander issued restarts now.
    if (!task.autoStart && task.botId) {
      const bot = await this.record.getActive('bot', task.botId);
      if (bot?.body.status === 'idle')
        await this.runner.start(taskId, ctx.actor).catch(() => undefined);
    }
  }
}
