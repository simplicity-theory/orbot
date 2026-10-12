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
import { DUPLICATE_THRESHOLD, similarity, titleFrom } from '../common/similarity.js';

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
    const proposedTasks = input.mission.definitionOfDone.map((item) => {
      const bot = [...bots].sort(
        (a, b) =>
          a.load - b.load || a.callsign.localeCompare(b.callsign, undefined, { numeric: true }),
      )[0];
      if (bot) bot.load++;
      return {
        title: item,
        description: `Part of mission “${input.mission.goal}”. Done when: ${item}.`,
        botId: bot?.id ?? null,
        scenario: 'happy-path',
      };
    });

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
}
