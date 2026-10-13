import { Injectable } from '@nestjs/common';
import {
  SETTINGS_ID,
  STAGE_ORDER,
  type RecordEventBody,
  type RecordEvent,
  type RecordVersion,
  type SupplyBody,
  type UnitBody,
} from '@orbot/shared';
import { RecordService } from '../record/record.service.js';
import { HQ_ACTOR } from './overseers.js';

type SandTable = RecordEventBody<'sand-table'>;
type Finding = SandTable['findings'][number];

/** "Engineers'" / "Guard's". */
const own = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

/** What a task costs when a unit has no history to go by, in compute units. */
const DEFAULT_TASK_COST = 4;
/** Words that mark a standing order as one that can hold work up. */
const HOLDS =
  /\b(block|blocks|never|must not|do not|don't|only|no longer|forbid|require|requires)\b/i;

/**
 * The sand table: HQ rehearses an operation's plan before the work is done for real.
 * It walks the handoff chain mission by mission against what is on the record now (bots,
 * stand-downs, standing orders, supply and deploy rights, budgets, approvals) and lists
 * blockers, risks and notes, each with what to do about it. Deterministic and free: no
 * model is asked. A rehearsal changes nothing; it is kept as a `sand-table` event.
 */
@Injectable()
export class SandTableService {
  constructor(private readonly record: RecordService) {}

  async latest(operationId: string): Promise<RecordEvent<'sand-table'> | null> {
    const [e] = await this.record.listEvents(
      { operationId, kinds: ['sand-table'], limit: 1 },
      { latest: true },
    );
    return (e as RecordEvent<'sand-table'> | undefined) ?? null;
  }

  async rehearse(operationId: string, actor: string): Promise<RecordEvent<'sand-table'>> {
    const op = await this.record.requireActive('operation', operationId);
    const [units, bots, missions, tasks, backbriefs, supply, settings] = await Promise.all([
      this.record.listActive('unit'),
      this.record.listActive('bot'),
      this.record.listActive('mission', { bodyContains: { operationId } }),
      this.record.listActive('task'),
      this.record.listActive('backbrief'),
      this.record.listActive('supply'),
      this.record.getActive('settings', SETTINGS_ID),
    ]);
    const findings: Finding[] = [];
    const add = (f: Omit<Finding, 'fix' | 'link'> & Partial<Pick<Finding, 'fix' | 'link'>>) =>
      findings.push({ fix: null, link: null, ...f });
    const s = settings?.body;

    const stageRank = (m: (typeof missions)[number]) =>
      m.body.stage ? STAGE_ORDER.indexOf(m.body.stage) : 99;
    const chain = (
      op.body.missionIds.length
        ? op.body.missionIds.map((id) => missions.find((m) => m.entityId === id))
        : [...missions].sort((a, b) => stageRank(a) - stageRank(b))
    ).filter((m): m is (typeof missions)[number] => !!m && m.body.status !== 'withdrawn');

    if (!chain.length) {
      add({
        severity: 'blocker',
        unitId: null,
        missionId: null,
        text: 'There is no plan yet: HQ has issued no missions.',
        fix: 'Wait for the O Group to finish, or state the intent again.',
      });
    }
    if (s?.halt) {
      add({
        severity: 'blocker',
        unitId: null,
        missionId: null,
        text: `All units are stood down (${s.halt.reason}): nothing will start.`,
        fix: 'Resume work from the banner.',
        link: '/',
      });
    }
    const builder = chain.length ? units.find((u) => u.entityId === chain[0]!.body.unitId) : null;
    const hasRepo = (u: UnitBody) =>
      supply.some(
        (x) =>
          u.supplyIds.includes(x.entityId) && x.body.connected && x.body.spec.kind === 'repository',
      );
    if (chain.length && !op.body.integrationBranch && !(builder && hasRepo(builder.body))) {
      add({
        severity: 'blocker',
        unitId: chain[0]!.body.unitId,
        missionId: chain[0]!.entityId,
        text: 'No repository: the work has nowhere to land.',
        fix: 'Allot a repository to the building unit from the Supply Depot.',
        link: '/supply',
      });
    }
    if (s?.mainEffort && s.mainEffort.operationId !== operationId) {
      const me = await this.record.getActive('operation', s.mainEffort.operationId);
      add({
        severity: 'note',
        unitId: null,
        missionId: null,
        text: `Operation ${me?.body.name ?? 'another operation'} is the main effort: its tasks go first, and this operation's work may wait or make way.`,
        fix: 'Make this operation the main effort if it should go first.',
        link: `/operations/${operationId}`,
      });
    } else if (s?.mainEffort?.operationId === operationId) {
      add({
        severity: 'note',
        unitId: null,
        missionId: null,
        text: 'This operation is the main effort: its tasks go first.',
      });
    }

    const perMission: SandTable['missions'] = [];
    const unitEstimate = new Map<string, number>();
    const seen = new Set<string>();
    for (const m of chain) {
      const unit = units.find((u) => u.entityId === m.body.unitId);
      if (!unit) continue;
      // Findings about the unit itself are listed once, at its first mission in the chain.
      const first = !seen.has(unit.entityId);
      seen.add(unit.entityId);
      const name = unit.body.name;
      const at = { unitId: unit.entityId, missionId: m.entityId };
      const unitLink = (section?: string) =>
        `/units/${unit.entityId}${section ? `?section=${section}` : ''}`;

      // Bots that can do the work.
      const workers = bots.filter(
        (b) =>
          b.body.unitId === unit.entityId &&
          !b.body.isOverseer &&
          b.body.status !== 'stood-down' &&
          !b.body.halt,
      );
      if (first && unit.body.halt) {
        add({
          ...at,
          severity: 'blocker',
          text: `${name} is stood down (${unit.body.halt.reason}): its mission won't start.`,
          fix: `Resume work for ${name}.`,
          link: unitLink(),
        });
      } else if (first && !workers.length) {
        add({
          ...at,
          severity: 'blocker',
          text: `${name} has no bot that can work.`,
          fix: `Add a bot to ${name}, or resume one that is stood down.`,
          link: unitLink(),
        });
      } else if (
        first &&
        workers.every((b) => b.body.status === 'blocked' || b.body.status === 'failed')
      ) {
        add({
          ...at,
          severity: 'risk',
          text: `Every ${name} bot is blocked or failed on other work.`,
          fix: `Clear ${own(name)} blocks first (see Needs you).`,
          link: unitLink(),
        });
      }
      if (first && !unit.body.overseerBotId) {
        add({
          ...at,
          severity: 'blocker',
          text: `${name} has no Overseer to plan and direct the mission.`,
          fix: `Give ${name} an Overseer.`,
          link: unitLink(),
        });
      }

      // Work already ahead of this mission in the unit's queue.
      const ahead = tasks.filter(
        (t) =>
          t.body.unitId === unit.entityId &&
          t.body.missionId !== m.entityId &&
          ['queued', 'working'].includes(t.body.status) &&
          !chain.some((c) => c.entityId === t.body.missionId),
      );
      if (
        first &&
        ahead.length >= workers.length &&
        workers.length &&
        s?.mainEffort?.operationId !== operationId
      ) {
        add({
          ...at,
          severity: 'risk',
          text: `${name} already has ${ahead.length} other task(s) queued or under way: this mission waits its turn.`,
          fix: 'Make this operation the main effort, or add a bot.',
          link: unitLink(),
        });
      }
      const stuck = tasks.filter(
        (t) => t.body.unitId === unit.entityId && ['blocked', 'failed'].includes(t.body.status),
      );
      if (first && stuck.length) {
        add({
          ...at,
          severity: 'risk',
          text: `${name} has ${stuck.length} blocked or failed task(s) already.`,
          fix: 'Deal with them first, or expect this mission to hit the same trouble.',
          link: unitLink(),
        });
      }

      // Standing orders that can hold the work up.
      for (const o of first ? unit.body.standingOrders.filter((x) => HOLDS.test(x.text)) : []) {
        add({
          ...at,
          severity: 'risk',
          text: `${own(name)} standing order may hold the work: “${o.text}”`,
          fix: 'Change the order in chat if it should not apply here.',
          link: unitLink('rules'),
        });
      }

      // Deploy rights and the Commander's approvals.
      if (m.body.stage === 'deploy' && !this.hasProduction(unit.body, supply)) {
        add({
          ...at,
          severity: 'blocker',
          text: `${name} has no production environment: the deploy will block.`,
          fix: `Grant ${name} production deploy rights (in chat, to HQ).`,
          link: '/chat/hq',
        });
      }
      if (m.body.stage === 'deploy') {
        add({
          ...at,
          severity: 'note',
          text: 'The production deploy waits for your approval.',
        });
      }
      const bb = backbriefs
        .filter((b) => b.body.missionId === m.entityId)
        .sort((a, b) => b.body.round - a.body.round)[0];
      if (bb?.body.status === 'awaiting-approval') {
        add({
          ...at,
          severity: 'note',
          text: `${own(name)} plan is waiting for your approval.`,
          link: `/approvals#backbrief-${bb.entityId}`,
        });
      }
      if (first && unit.body.rulesOfEngagement.mustEscalate.length) {
        add({
          ...at,
          severity: 'note',
          text: `${name} must escalate ${unit.body.rulesOfEngagement.mustEscalate.length} kind(s) of decision to you.`,
          link: unitLink('rules'),
        });
      }

      // HQ's estimate: the plan's tasks (or what's left of them), at the unit's usual cost.
      const missionTasks = tasks.filter((t) => t.body.missionId === m.entityId);
      const left = missionTasks.filter((t) => t.body.status !== 'done').length;
      const count = missionTasks.length ? left : bb ? bb.body.proposedTasks.length : 1;
      const perTask = await this.typicalCost(unit.entityId, tasks);
      const units_ = Math.round(count * perTask);
      perMission.push({
        missionId: m.entityId,
        unitId: unit.entityId,
        tasks: count,
        units: units_,
      });
      unitEstimate.set(unit.entityId, (unitEstimate.get(unit.entityId) ?? 0) + units_);
    }

    // Budgets: will the money last?
    const warnAt = s?.budgetWarnAt ?? 0.8;
    for (const [unitId, need] of unitEstimate) {
      const unit = units.find((u) => u.entityId === unitId)!;
      const cap = unit.body.computeBudget ?? 0;
      if (!cap || !need) continue;
      const left = cap - (await this.record.costOf({ unitId }));
      const at = {
        unitId,
        missionId: perMission.find((p) => p.unitId === unitId)?.missionId ?? null,
      };
      if (need > left) {
        add({
          ...at,
          severity: 'blocker',
          text: `${own(unit.body.name)} compute budget runs out: the plan needs about ${need} units, ${Math.max(0, left)} are left.`,
          fix: `Raise ${own(unit.body.name)} budget.`,
          link: `/units/${unitId}`,
        });
      } else if (need > left - cap * (1 - warnAt)) {
        add({
          ...at,
          severity: 'risk',
          text: `${own(unit.body.name)} compute budget will be close: about ${need} of the ${left} units left.`,
          fix: `Consider raising ${own(unit.body.name)} budget.`,
          link: `/units/${unitId}`,
        });
      }
    }
    const total = perMission.reduce((n, p) => n + p.units, 0);
    if (op.body.budgetUnits !== null && total) {
      const left = op.body.budgetUnits - (await this.record.costOf({ operationId }));
      if (total > left) {
        add({
          severity: 'blocker',
          unitId: null,
          missionId: null,
          text: `The operation's budget runs out: the plan needs about ${total} units, ${Math.max(0, left)} are left.`,
          fix: "Raise the operation's budget.",
          link: `/operations/${operationId}`,
        });
      }
    }

    const order = { blocker: 0, risk: 1, note: 2 } as const;
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    const blockers = findings.filter((f) => f.severity === 'blocker').length;
    const risks = findings.filter((f) => f.severity === 'risk').length;
    const body: SandTable = {
      verdict: blockers ? 'no-go' : 'go',
      findings,
      missions: perMission,
      estimate: { tasks: perMission.reduce((n, p) => n + p.tasks, 0), units: total },
    };
    return this.record.transaction(async (w) => {
      const e = await w.event('sand-table', body, { operationId }, actor);
      await w.event(
        'sitrep',
        {
          level: 'hq',
          text: `Sand table for Operation ${op.body.name}: ${
            blockers ? `no-go — ${blockers} blocker(s)` : 'go'
          }${risks ? `, ${risks} risk(s)` : ''}. About ${body.estimate.tasks} task(s), ${total} compute units.`,
          status: null,
        },
        { operationId },
        HQ_ACTOR,
      );
      return e as RecordEvent<'sand-table'>;
    });
  }

  private hasProduction(unit: UnitBody, supply: RecordVersion<SupplyBody>[]) {
    return supply.some(
      (x) =>
        unit.supplyIds.includes(x.entityId) &&
        x.body.connected &&
        x.body.spec.kind === 'environment' &&
        x.body.spec.details['tier'] === 'production',
    );
  }

  /** What a task usually costs this unit: its spend so far over its finished tasks. */
  private async typicalCost(
    unitId: string,
    tasks: { body: { unitId: string; status: string } }[],
  ): Promise<number> {
    const finished = tasks.filter(
      (t) => t.body.unitId === unitId && ['done', 'failed'].includes(t.body.status),
    ).length;
    if (!finished) return DEFAULT_TASK_COST;
    const spent = await this.record.costOf({ unitId });
    return spent ? Math.max(1, spent / finished) : DEFAULT_TASK_COST;
  }
}
