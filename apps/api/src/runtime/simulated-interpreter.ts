import type {
  ChatAction,
  InterpretInput,
  InterpretUnit,
  Interpretation,
  MessageKind,
} from '@orbot/shared';
import { words } from '../common/similarity.js';

const HEDGE =
  /\b(might|maybe|perhaps|possibly|thinking (about|of)|considering|may (give|add|grant)|could (probably )?(give|add|grant)|i'?d like to)\b/i;
const QUESTION_START =
  /^(how|what|where|when|why|who|which|is|are|was|were|did|do|does|has|have|can you tell|status)\b/i;
const DEPLOY_RIGHTS = /\b(production|prod)\b.*\b(deploy|release)|\bdeploy(ment)? rights\b/i;
const BUDGET = /\b(budget|compute)\b/i;
const GRANT =
  /\b(access to|give you|giving you|grant|granting|issue you|you can (use|have)|i'?ll (give|issue|grant))\b/i;
const RULE_NEGATIVE = /^(stop|don'?t|do not|never|no longer|quit)\b/i;
const RULE_POSITIVE = /^(always|from now on|going forward)\b/i;
const RESUME = /\b(resume|pick (it|that|.+) back up|restart|carry on with|un-?park)\b/i;
const FRAGO_DROP =
  /\b(drop|pause|hold off( on)?|put .+ on hold|park|shelve|deprioriti[sz]e)\b|\bfor now\b/i;
const FRAGO_AMEND = /\b(instead|also make sure|make sure|change .+ to)\b/i;
const DEPLOY_DECISION = /\b(approve|reject|refuse|hold)\b.*\b(deploy|deployment|release)\b/i;
const IMPERATIVE =
  /^(ship|launch|roll out|add|build|fix|implement|create|write|make|ship|refactor|update|remove|migrate|investigate|review|test|document|set up|harden|improve|support|rename|upgrade|split|clean up|automate|audit|scan)\b/i;
const FILLER = new Set([
  'work',
  'along',
  'far',
  'please',
  'now',
  'the',
  'thing',
  'stuff',
  'progress',
  'status',
  'going',
  'done',
]);

/** Content words of a phrase, minus chat filler. */
function topic(s: string): Set<string> {
  return new Set([...words(s)].filter((w) => !FILLER.has(w)));
}

/** Share of `about`'s words that also appear in `text` (0–1). */
function overlap(about: Set<string>, text: string): number {
  if (!about.size) return 0;
  const t = words(text);
  let n = 0;
  for (const w of about)
    if (t.has(w) || [...t].some((x) => x.startsWith(w.slice(0, 5)) && w.length > 4)) n++;
  return n / about.size;
}

/** A short code name from the intent's first content words, e.g. "Login Rate Limiting". */
function operationName(intent: string): string {
  const ws = [...words(intent)]
    .filter((w) => !['ship', 'launch', 'production', 'add', 'build', 'roll'].includes(w))
    .slice(0, 3);
  return ws.length ? ws.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : 'Unnamed';
}

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const stripEnd = (s: string) => s.replace(/[.!?\s]+$/, '');

/**
 * The simulated Overseer's reading of a chat message: rules and keywords, no model.
 * Deterministic, so chat works offline and in tests. Emits only typed actions.
 */
export class SimulatedInterpreter {
  interpret(input: InterpretInput): Interpretation {
    const out: Interpretation = {
      kinds: [],
      answer: null,
      actions: [],
      musings: [],
      missing: [],
      unclear: [],
    };
    const answers: string[] = [];
    const kinds = new Set<MessageKind>();

    for (const raw of input.message
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      const sentence = stripEnd(raw);
      const hedged = HEDGE.test(sentence);
      const isQuestion = !hedged && (/\?\s*$/.test(raw) || QUESTION_START.test(sentence));
      const unit = this.targetUnit(sentence, input);

      if (isQuestion) {
        kinds.add('question');
        answers.push(this.answer(sentence, unit, input));
        continue;
      }
      // Deploy approvals can be given from any channel.
      if (DEPLOY_DECISION.test(sentence)) {
        const approve = /\bapprove\b/i.test(sentence);
        const waiting = (unit ? [unit] : input.units).flatMap((u) =>
          u.tasks
            .filter((t) => t.kind === 'deploy' && t.status === 'awaiting-approval')
            .map((t) => ({ u, t })),
        );
        if (!waiting.length) {
          out.unclear.push(`${raw} — no deploy is waiting for approval.`);
        } else {
          kinds.add('order');
          for (const { u, t } of waiting)
            out.actions.push({ kind: 'approve-deploy', unitId: u.id, taskId: t.id, approve });
        }
        continue;
      }
      if (!unit) {
        // To HQ, an order that names no unit is a statement of intent: launch an operation.
        if (
          !input.channelUnitId &&
          (IMPERATIVE.test(sentence) || /\boperation\b/i.test(sentence))
        ) {
          const intent = sentenceCase(
            sentence.replace(/^(launch an? |start an? )?operation[:,]?\s*/i, ''),
          );
          const action: ChatAction = {
            kind: 'create-operation',
            unitId: null,
            intent: `${intent}.`,
            name: operationName(intent),
          };
          if (hedged) {
            kinds.add('musing');
            out.musings.push(action);
          } else {
            kinds.add('order');
            out.actions.push(action);
          }
          continue;
        }
        out.unclear.push(
          `${raw} — which unit should do this? Name it, or say it to that unit's Overseer.`,
        );
        continue;
      }
      const result = this.action(sentence, unit, input);
      if (!result) {
        out.unclear.push(raw);
        continue;
      }
      if ('missing' in result) {
        kinds.add('supply-grant');
        out.missing.push(result.missing);
        continue;
      }
      if ('unclear' in result) {
        out.unclear.push(result.unclear);
        continue;
      }
      if (hedged) {
        kinds.add('musing');
        out.musings.push(result.action);
      } else {
        kinds.add(result.kind);
        out.actions.push(result.action);
      }
    }
    out.kinds = [...kinds];
    out.answer = answers.length ? answers.join(' ') : null;
    return out;
  }

  /** A unit named in the sentence wins; otherwise the unit whose Overseer is addressed. */
  private targetUnit(sentence: string, input: InterpretInput): InterpretUnit | null {
    const named = input.units.find((u) => new RegExp(`\\b${u.name}\\b`, 'i').test(sentence));
    return named ?? input.units.find((u) => u.id === input.channelUnitId) ?? null;
  }

  private action(
    sentence: string,
    unit: InterpretUnit,
    input: InterpretInput,
  ):
    | { kind: MessageKind; action: ChatAction }
    | { missing: Interpretation['missing'][number] }
    | { unclear: string }
    | null {
    // "Guard, review the…" → classify "review the…".
    sentence = sentence.replace(new RegExp(`^${unit.name},?\\s+`, 'i'), '');
    // Production deploy rights (irreversible).
    if (DEPLOY_RIGHTS.test(sentence) && GRANT.test(sentence)) {
      const env = input.depot.find(
        (d) => d.kind === 'environment' && d.tier === 'production' && d.connected,
      );
      if (!env) return { missing: { what: 'a production environment', kind: 'environment' } };
      return {
        kind: 'supply-grant',
        action: { kind: 'grant-deploy-rights', unitId: unit.id, supplyId: env.id },
      };
    }
    // Compute budget.
    if (BUDGET.test(sentence) && /\b(give|grant|add|more|extra|increase|raise)\b/i.test(sentence)) {
      const n = Number(/(\d+)/.exec(sentence)?.[1] ?? 10);
      return { kind: 'supply-grant', action: { kind: 'budget-grant', unitId: unit.id, units: n } };
    }
    // Supply from the depot.
    if (GRANT.test(sentence)) {
      const m =
        /\baccess to\s+(?:the\s+|our\s+)?(.+)$/i.exec(sentence) ??
        /(?:give you|giving you|grant you|issue you|use|have)\s+(?:the\s+|our\s+)?(.+)$/i.exec(
          sentence,
        );
      const phrase = (m?.[1] ?? sentence).replace(/\s+(to|for)\s+\w+$/i, '');
      const kindWord = /\b(repo|repository)\b/i.test(phrase)
        ? 'repository'
        : /\benvironment\b/i.test(phrase)
          ? 'environment'
          : /\b(credential|token|key|secret)\b/i.test(phrase)
            ? 'credential'
            : 'supply';
      const name = phrase
        .replace(/\b(repo|repository|environment|credential|token)\b/gi, '')
        .trim();
      const want = topic(name);
      const hit = input.depot
        .filter((d) => d.connected && (kindWord === 'supply' || d.kind === kindWord))
        .map((d) => ({ d, score: overlap(want, d.name.replace(/[-_]/g, ' ')) }))
        .sort((a, b) => b.score - a.score)[0];
      if (!hit || hit.score < 0.5)
        return {
          missing: {
            what: `${name || phrase} ${kindWord === 'supply' ? '' : kindWord}`.trim(),
            kind: kindWord,
          },
        };
      return {
        kind: 'supply-grant',
        action: { kind: 'supply-grant', unitId: unit.id, supplyId: hit.d.id },
      };
    }
    // Standing orders.
    if (
      RULE_NEGATIVE.test(sentence) ||
      RULE_POSITIVE.test(sentence) ||
      /\bstanding order\b/i.test(sentence)
    ) {
      const rest = topic(sentence.replace(RULE_NEGATIVE, '').replace(RULE_POSITIVE, ''));
      // Remove only the best-matching order(s): "low-severity findings" must not take
      // "high and critical findings" with it just because both mention findings.
      const scored = unit.standingOrders.map((o) => ({ o, score: overlap(rest, o.text) }));
      const best = Math.max(0, ...scored.map((x) => x.score));
      const removeOrders =
        RULE_NEGATIVE.test(sentence) && best >= 0.5
          ? scored.filter((x) => x.score === best).map((x) => x.o.id)
          : [];
      return {
        kind: 'rule-change',
        action: {
          kind: 'rule-change',
          unitId: unit.id,
          removeOrders,
          addOrders: [`${sentenceCase(sentence)}.`],
          removeRoe: [],
          addRoe: [],
        },
      };
    }
    // Fragos: change work in progress.
    if (RESUME.test(sentence)) {
      const ids = this.matchTasks(sentence, unit, ['stood-down']);
      if (!ids.length) return { unclear: `${sentence} — no stood-down work matches that.` };
      return {
        kind: 'frago',
        action: {
          kind: 'resume',
          unitId: unit.id,
          taskIds: ids,
          note: `${sentenceCase(sentence)}.`,
        },
      };
    }
    if (FRAGO_DROP.test(sentence) || FRAGO_AMEND.test(sentence)) {
      const ids = this.matchTasks(sentence, unit, ['queued', 'working', 'blocked']);
      if (!ids.length)
        return { unclear: `${sentence} — no work in progress in ${unit.name} matches that.` };
      const change = FRAGO_DROP.test(sentence) ? 'stand-down' : 'amend';
      return {
        kind: 'frago',
        action: {
          kind: 'frago',
          unitId: unit.id,
          change,
          taskIds: ids,
          note: `${sentenceCase(sentence)}.`,
        },
      };
    }
    // Plain orders: new work.
    if (IMPERATIVE.test(sentence)) {
      const goal = sentence.replace(new RegExp(`^${unit.name},?\\s+`, 'i'), '');
      return {
        kind: 'order',
        action: {
          kind: 'create-mission',
          unitId: unit.id,
          goal: sentenceCase(goal),
          definitionOfDone: [sentenceCase(goal)],
        },
      };
    }
    return null;
  }

  /** Tasks (in the given states) or tasks of missions whose words match the sentence. */
  private matchTasks(sentence: string, unit: InterpretUnit, states: string[]): string[] {
    const about = topic(
      sentence
        .replace(FRAGO_DROP, ' ')
        .replace(FRAGO_AMEND, ' ')
        .replace(RESUME, ' ')
        .replace(new RegExp(`\\b${unit.name}\\b`, 'i'), ' '),
    );
    const live = unit.tasks.filter((t) => states.includes(t.status));
    const direct = live.filter((t) => overlap(about, t.title) >= 0.5).map((t) => t.id);
    if (direct.length) return direct;
    const missions = unit.missions.filter((m) => overlap(about, m.goal) >= 0.5).map((m) => m.id);
    return live.filter((t) => t.missionId && missions.includes(t.missionId)).map((t) => t.id);
  }

  private answer(sentence: string, unit: InterpretUnit | null, input: InterpretInput): string {
    const about = topic(sentence.replace(QUESTION_START, ''));
    const scope = unit ? [unit] : input.units;
    for (const u of scope) {
      const mission = u.missions
        .map((m) => ({ m, score: overlap(about, m.goal) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.m;
      if (mission) {
        const trouble = u.tasks
          .filter(
            (t) => t.missionId === mission.id && (t.status === 'blocked' || t.status === 'failed'),
          )
          .map((t) => `#${t.number} ${t.status}: ${t.statusReason ?? t.title}`);
        return `“${mission.goal}” (${u.name}) is ${mission.status}: ${mission.done} of ${mission.total} task(s) done.${trouble.length ? ` ${trouble.join('; ')}.` : ''}`;
      }
      const task = u.tasks
        .map((t) => ({ t, score: overlap(about, t.title) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.t;
      if (task) {
        return `Task #${task.number} “${task.title}” (${u.name}) is ${task.status}${task.botCallsign ? ` with ${task.botCallsign}` : ''}${task.statusReason ? `: ${task.statusReason}` : ''}.`;
      }
    }
    return scope
      .map((u) => {
        const by = (s: string) => u.tasks.filter((t) => t.status === s).length;
        const active = u.missions
          .filter((m) => m.status !== 'done' && m.status !== 'withdrawn')
          .map((m) => `“${m.goal}”`);
        return `${u.name}: ${by('working')} working, ${by('blocked')} blocked, ${by('failed')} failed, ${by('queued')} queued.${active.length ? ` Missions: ${active.join(', ')}.` : ''}`;
      })
      .join(' ');
  }
}
