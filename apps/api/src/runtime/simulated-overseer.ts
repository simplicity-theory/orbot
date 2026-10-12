import {
  parseHandoverMarkdown,
  type BackbriefDraft,
  type BackbriefInput,
  type ColdStartAssessment,
  type ColdStartGap,
  type ColdStartInput,
  type CurationAction,
  type CurationInput,
} from '@orbot/shared';
import { DUPLICATE_THRESHOLD, similarity, titleFrom, words } from '../common/similarity.js';
import type {
  AfterActionInput,
  AfterActionReview,
  DisputeInput,
  DisputeRuling,
  OperationPlan,
  OperationPlanInput,
  ProposedTask,
} from '@orbot/shared';

/** A lesson that applies beyond the task it came from. */
export function isGeneral(lesson: string): boolean {
  return !/orbot\/task-\d+|task #\d+|#\d+\b|\byet\b/i.test(lesson);
}

/**
 * The simulated Overseer's judgement. Deterministic rules standing in for a model:
 * the command system around it is what is being exercised.
 */
export class SimulatedOverseer {
  draftBackbrief(input: BackbriefInput): BackbriefDraft {
    const bots = input.bots
      .filter((b) => b.status !== 'stood-down' && b.status !== 'failed')
      .map((b) => ({
        ...b,
        load: b.queueLength + (b.status === 'working' || b.status === 'blocked' ? 1 : 0),
      }));
    const pick = () => {
      const bot = [...bots].sort(
        (a, b) =>
          a.load - b.load || a.callsign.localeCompare(b.callsign, undefined, { numeric: true }),
      )[0];
      if (bot) bot.load++;
      return bot?.id ?? null;
    };
    // In an operation, each stage has its own kind of work.
    const stage = input.mission.stage;
    const proposedTasks: ProposedTask[] =
      stage === 'inspect' || stage === 'guard' || stage === 'deploy'
        ? [
            {
              title: input.mission.goal,
              description: `Stage “${stage}” of the operation. Done when: ${input.mission.definitionOfDone.join('; ')}.`,
              botId: pick(),
              scenario:
                stage === 'inspect'
                  ? 'inspect-strict'
                  : stage === 'guard'
                    ? 'guard-check'
                    : 'deploy',
              kind: stage === 'deploy' ? 'deploy' : 'check',
            },
          ]
        : input.mission.definitionOfDone.map((item) => ({
            title: item,
            description: `Part of mission “${input.mission.goal}”. Done when: ${item}.`,
            botId: pick(),
            scenario: 'happy-path',
            kind: 'work' as const,
          }));

    const risks: string[] = [];
    if (!bots.length)
      risks.push('No bot is free to take this work; tasks are unassigned until one is added.');
    for (const e of input.fieldManual) {
      const overlap = input.mission.definitionOfDone.some(
        (d) => similarity(d, `${e.title} ${e.body}`) > 0.15,
      );
      if (overlap) risks.push(`Field Manual: ${e.title}.`);
    }
    for (const note of input.commanderNotes)
      risks.push(`Commander's note taken into account: “${note}”.`);

    const who = [
      ...new Set(
        proposedTasks
          .map((t) => input.bots.find((b) => b.id === t.botId)?.callsign)
          .filter(Boolean),
      ),
    ];
    const summary =
      `${input.unit.name} will deliver “${input.mission.goal}” in ${proposedTasks.length} task${proposedTasks.length === 1 ? '' : 's'}` +
      (who.length ? `, worked by ${who.join(', ')}` : '') +
      `.` +
      (input.round > 1 ? ` Revised plan (round ${input.round}).` : '');
    return { summary, proposedTasks, risks };
  }

  curate(input: CurationInput): CurationAction[] {
    const note = parseHandoverMarkdown(input.handover.markdown);
    const actions: CurationAction[] = [];
    const entries = input.entries.map((e) => ({ ...e }));
    const source = input.handover.taskNumber
      ? `task #${input.handover.taskNumber} handover`
      : 'a handover';

    // "Obsolete: <title>" in a handover retires that entry.
    for (const item of [...note.flagsForSuccessor, ...note.openProblems]) {
      const m = /^obsolete:\s*(.+)$/i.exec(item);
      if (!m) continue;
      const target = entries.find(
        (e) =>
          similarity(e.title, m[1]!) >= DUPLICATE_THRESHOLD ||
          e.title.toLowerCase() === m[1]!.trim().toLowerCase(),
      );
      if (target)
        actions.push({
          kind: 'retire',
          entryId: target.entryId,
          reason: `Marked obsolete in ${source}.`,
        });
    }

    // Only general flags are lasting lessons. Anything tied to this task (its branch, its
    // number, "yet") stays in the handover, where a successor on the same task will read it.
    // Tried-and-failed notes stay in the handover too: they are about this piece of work.
    const lessons = note.flagsForSuccessor.filter((l) => !/^obsolete:/i.test(l) && isGeneral(l));
    for (const lesson of lessons) {
      const dup = entries.find(
        (e) => similarity(`${e.title} ${e.body}`, lesson) >= DUPLICATE_THRESHOLD,
      );
      if (dup) {
        actions.push({
          kind: 'merge',
          entryId: dup.entryId,
          body: null,
          reason: `Same lesson again in ${source}.`,
        });
        continue;
      }
      const promoted = {
        entryId: `new-${entries.length}`,
        title: titleFrom(lesson),
        body: lesson,
        tags: [],
      };
      entries.push(promoted);
      actions.push({
        kind: 'promote',
        title: promoted.title,
        body: lesson,
        tags: ['lesson'],
        reason: `Lasting lesson from ${source}.`,
      });
    }
    return actions;
  }

  assessColdStart(input: ColdStartInput): ColdStartAssessment {
    const gaps: ColdStartGap[] = [];
    const inFlight = input.task && input.task.status !== 'done';
    if (input.task && inFlight && !input.lastHandover) {
      gaps.push({
        description: `Task #${input.task.number} is ${input.task.status} but has no handover: a fresh bot could not tell what was done.`,
        suggestedEntry: null,
      });
    }
    if (input.lastHandover) {
      const note = parseHandoverMarkdown(input.lastHandover.markdown);
      if (inFlight && note.nextSteps.length === 0) {
        gaps.push({
          description: `The handover for task #${input.task!.number} lists no next steps.`,
          suggestedEntry: null,
        });
      }
      // Anything a predecessor flagged that the Field Manual doesn't yet say.
      for (const flag of note.flagsForSuccessor) {
        const covered = input.fieldManual.some(
          (e) => similarity(`${e.title} ${e.body}`, flag) >= DUPLICATE_THRESHOLD,
        );
        if (!covered) {
          gaps.push({
            description: `Flag only in a handover, not in the Field Manual: “${flag.replace(/\.$/, '')}”.`,
            suggestedEntry: { title: titleFrom(flag), body: flag },
          });
        }
      }
    }
    if (input.fieldManual.length === 0) {
      gaps.push({
        description: 'The Field Manual is empty: a fresh bot would have no unit conventions.',
        suggestedEntry: null,
      });
    }
    return { score: Math.max(0, 100 - gaps.length * 25), gaps };
  }

  /** O Group: one mission per unit, ordered build → inspect → guard → deploy, matched by each unit's role. */
  planOperation(input: OperationPlanInput): OperationPlan {
    const stageOf = (u: OperationPlanInput['units'][number]) => {
      const text = `${u.name} ${u.role}`.toLowerCase();
      if (/engineer|develop/.test(text)) return 'build' as const;
      if (/inspect|qa|test/.test(text)) return 'inspect' as const;
      if (/guard|secur/.test(text)) return 'guard' as const;
      if (/logistic|devops|ops|deploy/.test(text)) return 'deploy' as const;
      return null;
    };
    const intent = input.intent.replace(/[.!]+$/, '');
    const goals = {
      build: { goal: intent, dod: [intent] },
      inspect: {
        goal: `Prove it works: ${intent}`,
        dod: ['Tests cover the change', 'Tests pass on the integration branch'],
      },
      guard: { goal: `Security review: ${intent}`, dod: ['No high or critical findings'] },
      deploy: {
        goal: `Deploy to production: ${intent}`,
        dod: ['Deployed to production with the Commander’s approval'],
      },
    };
    const order = ['build', 'inspect', 'guard', 'deploy'] as const;
    const missions = order.flatMap((stage) => {
      const unit = input.units.find((u) => stageOf(u) === stage);
      return unit
        ? [{ unitId: unit.id, stage, goal: goals[stage].goal, definitionOfDone: goals[stage].dod }]
        : [];
    });
    return { name: input.name, missions };
  }

  /**
   * HQ rules under standing orders: the order (of either unit) that best matches the claim
   * settles it, and its unit prevails. If no order speaks to it, HQ refers it upward.
   */
  ruleDispute(input: DisputeInput): DisputeRuling {
    const claim = words(input.claim);
    const candidates = [
      ...input.raiser.standingOrders.map((o) => ({ o, side: 'raiser' as const, u: input.raiser })),
      ...input.other.standingOrders.map((o) => ({ o, side: 'other' as const, u: input.other })),
    ].map((c) => {
      const ws = [...words(c.o.text)];
      return { ...c, score: ws.length ? ws.filter((w) => claim.has(w)).length / ws.length : 0 };
    });
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 0.5) {
      return {
        prevails: null,
        reasoning: `No standing order of ${input.raiser.name} or ${input.other.name} settles this.`,
        cited: [],
      };
    }
    return {
      prevails: best.side,
      reasoning: `${best.u.name}'s standing order “${best.o.text}” settles it: ${best.u.name} prevails.`,
      cited: [{ unitId: best.u.id, orderId: best.o.id, text: best.o.text }],
    };
  }

  afterAction(input: AfterActionInput): AfterActionReview {
    const of = (k: string) => input.timeline.filter((t) => t.kind === k);
    const sendbacks = of('sendback');
    const blocks = of('blocked');
    const handoffs = of('handoff');
    const deployed = of('deployment').length > 0;
    const lessons: AfterActionReview['lessons'] = [];
    for (const s of sendbacks) {
      const unit = input.units.find((u) => u.name === s.unit);
      lessons.push({
        unitId: unit?.id ?? null,
        text: `Before handing over, check: ${s.text.replace(/^Sent back[^:]*:\s*/i, '').replace(/[.]$/, '')}.`,
      });
    }
    for (const b of blocks) {
      if (/deploy rights|not been issued|no access/i.test(b.text)) {
        lessons.push({
          unitId: null,
          text: `Issue supply before the work that needs it starts (blocked: ${b.text.replace(/[.]$/, '')}).`,
        });
      }
    }
    return {
      summary: `Operation ${input.operation.name}: ${deployed ? 'deployed to production' : 'not deployed'} after ${handoffs.length} handoff(s), ${sendbacks.length} send-back(s) and ${blocks.length} block(s).`,
      wentWell: [
        ...(deployed ? ['The change reached production with your approval.'] : []),
        ...(handoffs.length
          ? [`Every handoff carried the same integration branch (${handoffs.length} in total).`]
          : []),
      ],
      toImprove: [
        ...sendbacks.map((s) => `Send-back: ${s.text}`),
        ...blocks.map((b) => `Block: ${b.text}`),
      ],
      lessons,
    };
  }
}
