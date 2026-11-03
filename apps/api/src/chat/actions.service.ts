import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  describeHoldPolicy,
  type ChatAction,
  type ChatLink,
  type TaskBody,
  type TaskStatus,
} from '@orbot/shared';
import { HoldPolicyService } from '../policy/hold-policy.service.js';
import { TaskRunner } from '../execution/task-runner.js';
import { HqService } from '../overseer/hq.service.js';
import { MainEffortService } from '../overseer/main-effort.service.js';
import { ConnectionsService } from '../connections/connections.service.js';
import { ReconService } from '../overseer/recon.service.js';
import { SandTableService } from '../overseer/sand-table.service.js';
import { StandDownService } from '../overseer/stand-down.service.js';
import { BudgetService } from '../overseer/budget.service.js';
import { OverseerService } from '../overseer/overseer.service.js';
import { RecordService, type WriteContext } from '../record/record.service.js';
import { ProjectsService } from '../supply/projects.service.js';
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
    private readonly budget: BudgetService,
    private readonly mainEffort: MainEffortService,
    private readonly recon: ReconService,
    private readonly sandTables: SandTableService,
    private readonly connections: ConnectionsService,
    private readonly projects: ProjectsService,
    private readonly holds: HoldPolicyService,
  ) {}

  async run(action: ChatAction, ctx: WriteContext): Promise<ActionResult> {
    if (action.kind === 'hold-policy') {
      if (action.operationId) {
        const before = (await this.record.requireActive('operation', action.operationId)).body
          .holdPolicy;
        const op = await this.holds.setOperation(action.operationId, action.policy, ctx);
        return {
          summary: action.policy
            ? `Hold policy for Operation ${op.body.name}: ${describeHoldPolicy(action.policy)}`
            : `Operation ${op.body.name} is back to each unit’s own hold policy.`,
          links: [{ label: `Operation ${op.body.name}`, link: `/operations/${op.entityId}` }],
          inverse: { ...action, policy: before },
          affects: [],
        };
      }
      const unitId = action.unitId!;
      const before = (await this.record.requireActive('unit', unitId)).body.holdPolicy;
      const unit = await this.holds.setUnit(unitId, action.policy ?? before, ctx);
      return {
        summary: `${unit.body.name}'s hold policy: ${describeHoldPolicy(unit.body.holdPolicy)}`,
        links: [{ label: `${unit.body.name} rules`, link: unitLink(unitId, 'rules') }],
        inverse: { ...action, policy: before },
        affects: [],
      };
    }
    if (action.kind === 'new-project') {
      const p = await this.projects.start(
        {
          name: action.name,
          kind: action.projectKind,
          intent: action.intent,
          budgetUnits: null,
          deployRightsUnitId: null,
        },
        ctx,
      );
      return {
        summary:
          `Project ${action.name} started: repository ${p.repository.body.name} (one HTML file) and its site ${p.site.body.name} are in the Supply Depot.` +
          (p.operation
            ? ` Operation ${p.operation.body.name} launched with both; HQ is holding the O Group. Give the deploying unit deploy rights to ${p.site.body.name} when you are ready.`
            : ' State your intent, using both, when you are ready.'),
        links: [
          ...(p.operation
            ? [
                {
                  label: `Operation ${p.operation.body.name}`,
                  link: `/operations/${p.operation.entityId}`,
                },
              ]
            : []),
          { label: p.repository.body.name, link: '/supply' },
          { label: p.site.body.name, link: '/supply?section=environments' },
        ],
        // Nothing is deleted: a project, once started, stays in the depot.
        inverse: null,
        affects: [],
      };
    }
    if (action.kind === 'create-operation') {
      const op = await this.hq.createOperation(
        action.intent,
        action.name,
        ctx.actor,
        null,
        false,
        action.supplyIds,
      );
      const names = (await this.hq.resourcesOf(op)).map((r) => r.body.name);
      return {
        summary:
          `Operation ${op.body.name} launched: HQ is holding the O Group and will issue missions to the units.` +
          (names.length
            ? ` Resources: ${names.join(', ')}.`
            : ' It has no resources yet: it waits at the O Group until it has a repository.'),
        links: [{ label: `Operation ${op.body.name}`, link: `/operations/${op.entityId}` }],
        inverse: null,
        affects: [],
      };
    }
    if (action.kind === 'assign-resource' || action.kind === 'release-resource') {
      const link = { label: 'Resources', link: `/operations/${action.operationId}#resources` };
      if (action.kind === 'assign-resource') {
        const r = await this.hq.assignResource(action.operationId, action.supplyId, ctx.actor);
        return {
          summary: r.added
            ? `${r.supply.body.name} assigned to Operation ${r.op.body.name}.`
            : `${r.supply.body.name} was already assigned to Operation ${r.op.body.name}.`,
          links: [link],
          inverse: r.added ? { ...action, kind: 'release-resource' } : null,
          affects: [],
        };
      }
      const r = await this.hq.releaseResource(action.operationId, action.supplyId, ctx.actor);
      return {
        summary: r.removed
          ? `${r.supply.body.name} taken off Operation ${r.op.body.name}. Units that hold it keep it.`
          : `${r.supply.body.name} was not assigned to Operation ${r.op.body.name}.`,
        links: [link],
        inverse: r.removed ? { ...action, kind: 'assign-resource' } : null,
        affects: [],
      };
    }
    if (action.kind === 'set-main-repository') {
      const r = await this.hq.setMainRepository(action.operationId, action.supplyId, ctx.actor);
      const name = r.op.body.name;
      return {
        summary: !r.changed
          ? `${r.supply.body.name} is already the main repository of Operation ${name}.`
          : r.restarted
            ? `Operation ${name} now works in ${r.supply.body.name}: its missions were withdrawn and are issued again there, so each unit briefs back afresh. Work already done stays on ${r.was?.body.name ?? 'the old repository'}'s branches.`
            : `${r.supply.body.name} is now the main repository of Operation ${name}.`,
        links: [{ label: 'Resources', link: `/operations/${action.operationId}#resources` }],
        // Withdrawn work is not put back: changing again issues the missions afresh.
        inverse: null,
        affects: [],
      };
    }
    if (action.kind === 'cancel-operation') {
      const op = await this.hq.cancelOperation(action.operationId, action.note, ctx.actor);
      return {
        summary: `Operation ${op.body.name} cancelled. Its work stood down and stays on record.`,
        links: [{ label: `Operation ${op.body.name}`, link: `/operations/${op.entityId}` }],
        inverse: null,
        affects: [],
      };
    }
    if (action.kind === 'restart-operation') {
      const op = await this.hq.restartOperation(action.operationId, action.note, ctx.actor);
      return {
        summary: `Operation ${op.body.name} started over: its missions are withdrawn and issued again from the same plan; each unit briefs back afresh.`,
        links: [{ label: `Operation ${op.body.name}`, link: `/operations/${op.entityId}` }],
        inverse: null,
        affects: [],
      };
    }
    if (action.kind === 'rehearse') {
      const e = await this.sandTables.rehearse(action.operationId, ctx.actor);
      const op = await this.record.requireActive('operation', action.operationId);
      const blockers = e.body.findings.filter((f) => f.severity === 'blocker');
      return {
        summary: `Sand table for Operation ${op.body.name}: ${
          e.body.verdict === 'go' ? 'go' : `no-go — ${blockers.map((b) => b.text).join(' ')}`
        }`,
        links: [{ label: 'Sand table', link: `/operations/${op.entityId}#sand-table` }],
        inverse: null,
        affects: [],
      };
    }
    if (action.kind === 'main-effort') {
      const r = await this.mainEffort.set(action.operationId, action.reason, ctx.actor);
      return {
        summary: action.operationId
          ? `${r.label} is now the main effort: its tasks go first, and other work makes way for it.`
          : 'No main effort any more: work goes in normal queue order.',
        links: action.operationId
          ? [{ label: r.label, link: `/operations/${action.operationId}` }]
          : [{ label: 'Operations', link: '/operations' }],
        inverse: {
          kind: 'main-effort',
          unitId: null,
          operationId: r.previous,
          reason: `Undo: ${action.reason}`,
        },
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
          { preApproved: true },
        );
        return {
          summary: `New mission for ${u}: “${action.goal}”. You ordered it, so the Overseer’s plan goes ahead without waiting for approval.`,
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
        const mission = await this.hq.abortMission(action.missionId, action.note, ctx.actor);
        return {
          summary: `Aborted the mission “${mission.body.goal}” (${u}): its work stood down and stays on record${mission.body.operationId ? '; the operation waits until it is started over or cancelled' : ''}.`,
          links: [{ label: mission.body.goal, link: unitLink(action.unitId) }],
          inverse: null,
          affects: [],
        };
      }
      case 'restart-mission': {
        const mission = await this.hq.restartMission(action.missionId, action.note, ctx.actor);
        return {
          summary: `Mission “${mission.body.goal}” started over: issued again to ${u}, which briefs back afresh. What was done stays on record.`,
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
      case 'decide-permission': {
        const before = await this.record.requireActive('task', action.taskId);
        const t = await this.overseer.decidePermission(
          action.taskId,
          action.approve,
          action.note ?? 'Given in chat',
          ctx.actor,
        );
        const what = before.body.permission?.action ?? 'its request';
        return {
          summary: action.approve
            ? `Permission given to task #${t.body.number} (${u}): ${what}.`
            : `Permission refused to task #${t.body.number} (${u}): ${what}.`,
          links: [{ label: `Task #${t.body.number}`, link: taskLink(t.body, t.entityId) }],
          // The bot acts on it straight away: a decision cannot be taken back.
          inverse: null,
          affects: [],
        };
      }
      case 'take-issue': {
        const m = await this.connections.takeIssue(
          action.connectionId,
          action.unitId,
          action.number,
          ctx.actor,
        );
        return {
          summary: `${u} takes on issue #${action.number}: new mission “${m.body.goal}”. You ordered it, so the Overseer’s plan goes ahead without waiting for approval.`,
          links: [{ label: m.body.goal, link: unitLink(action.unitId) }],
          inverse: {
            kind: 'withdraw-mission',
            unitId: action.unitId,
            missionId: m.entityId,
            note: 'Undo of a chat order',
          },
          affects: [],
        };
      }
      case 'recon': {
        const task = await this.recon.order(
          { unitId: action.unitId, question: action.question, repoSupplyId: action.repoSupplyId },
          ctx.actor,
          ctx.reason,
        );
        return {
          summary: `${u} sent ${task.body.botId ? 'a bot ' : ''}on recon (task #${task.body.number}): “${action.question}”. Read-only; the report will be filed with ${u}.`,
          links: [
            { label: `Recon #${task.body.number}`, link: taskLink(task.body, task.entityId) },
          ],
          inverse: {
            kind: 'frago',
            unitId: action.unitId,
            change: 'stand-down',
            taskIds: [task.entityId],
            note: 'Recon called off',
          },
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
        const released = await this.budget.release({ unitId: action.unitId }, ctx.actor);
        return {
          summary: `${u} compute budget ${action.units >= 0 ? 'raised' : 'lowered'} by ${Math.abs(action.units)} to ${next.body.computeBudget} units.${
            released.length ? ` ${released.length} task(s) held at the cap resumed.` : ''
          }`,
          links: [{ label: `${u}`, link: unitLink(action.unitId) }],
          inverse: { kind: 'budget-grant', unitId: action.unitId, units: -action.units },
          affects: [],
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
        (t) => ({ ...t, status: 'stood-down', statusReason: reason, statusAction: null }),
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
        (t) => ({ ...t, status: 'queued', statusReason: `Resumed: ${note}`, statusAction: null }),
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
