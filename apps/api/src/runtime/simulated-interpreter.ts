import {
  DEFAULT_HOLD_POLICY,
  type ChatAction,
  type HoldPolicy,
  type InterpretInput,
  type InterpretUnit,
  type Interpretation,
  type MessageKind,
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
/**
 * Hold policy, in words: "hold only on critical findings", "automatic: nothing ever holds",
 * "fix up to medium", "only record findings", "back to the units' own settings".
 */
const HOLD_AUTOMATIC =
  /\b(full(?:y)?[- ]?automatic|automatic(?: mode)?|never (?:hold|block)|nothing (?:ever )?(?:holds|blocks)|don'?t (?:ever )?(?:hold|block)(?: the work)?)\b/i;
const HOLD_FROM =
  /\b(?:hold|block)(?: the work)?(?: only)? (?:on|from|at) (low|medium|high|critical)\b|\bonly (low|medium|high|critical)(?: findings)? (?:hold|block)/i;
const FIX_UP_TO = /\bfix(?:es)? (?:anything )?up to (small|medium|large)\b/i;
const FIX_ANY = /\bfix anything\b|\bfix (?:findings )?whatever the size\b/i;
const FIX_NONE = /\b(?:only record|record only|never fix|don'?t fix)\b/i;
const HOLD_RESET =
  /\b(?:back to|use) (?:the |each )?units?'?s? own(?: hold)?(?: polic(?:y|ies)| settings?)?\b/i;
const MENTIONS_HOLD = /\b(hold|holds|block|blocks|finding|findings|fix|fixes|automatic)\b/i;

function holdPolicyChange(sentence: string, current: HoldPolicy): HoldPolicy | null {
  if (!MENTIONS_HOLD.test(sentence)) return null;
  const next: HoldPolicy = { ...current };
  let changed = false;
  if (HOLD_AUTOMATIC.test(sentence)) {
    next.holdFrom = 'never';
    changed = true;
  }
  const from = HOLD_FROM.exec(sentence);
  if (from) {
    next.holdFrom = (from[1] ?? from[2])!.toLowerCase() as HoldPolicy['holdFrom'];
    changed = true;
  }
  const upTo = FIX_UP_TO.exec(sentence);
  if (upTo) {
    next.fixUpTo = upTo[1]!.toLowerCase() as HoldPolicy['fixUpTo'];
    changed = true;
  } else if (FIX_ANY.test(sentence)) {
    next.fixUpTo = 'large';
    changed = true;
  } else if (FIX_NONE.test(sentence)) {
    next.fixUpTo = 'none';
    changed = true;
  }
  return changed ? next : null;
}

const RULE_NEGATIVE = /^(stop|don'?t|do not|never|no longer|quit)\b/i;
const RULE_POSITIVE = /^(always|from now on|going forward)\b/i;
const RESUME = /\b(resume|pick (it|that|.+) back up|restart|carry on with|un-?park)\b/i;
const STAND_DOWN =
  /\b(stand(?:\s+[\w-]+){0,2}\s+down|stand-down|all stop|down tools|stop (?:all )?work|stop everything|halt)\b/i;
const LIFT =
  /\b(resume work|resume|back to work|as you were|stand to|carry on|lift the stand[- ]?down|stand[- ]?down (?:is )?(?:lifted|over))\b/i;
const EVERYTHING =
  /\b(everything|everyone|everybody|all units|all bots|all work|all of you|whole force)\b/i;
const SCOPE_WORDS = new Set(['unit', 'bots', 'team', 'all', 'order', 'tools', 'everyone', 'stop']);
const REASON = /[,:;—-]?\s*\b(because|while|until|since|so that|so)\b\s+(.+)$/i;
const TAKE_ISSUE = /\b(?:take on|take|pick up|work on|handle)\s+issue\s+#?(\d+)\b/i;
const RECON =
  /^(recon|reconnoitre|reconnoiter|scout(?: out)?|survey|find out|look into)\b[:,]?\s*/i;
const REHEARSE = /\b(rehearse|rehearsal|sand ?table|walk (me )?through the plan|war-?game)\b/i;
const MAIN_EFFORT = /\bmain effort\b/i;
/** "Use payments-service and gpu1 for Operation Ledger" / "Take gpu1 off Operation Ledger". */
const RESOURCE_ASSIGN =
  /^(?:please\s+)?(?:use|assign|give|add|allocate|attach)\s+(.+?)\s+(?:to|for|on)\s+(?:the\s+)?(?:operation|op)\b\s*(.*)$/i;
const RESOURCE_RELEASE =
  /^(?:please\s+)?(?:release|remove|take|detach|drop)\s+(.+?)\s+(?:from|off)\s+(?:of\s+)?(?:the\s+)?(?:operation|op)\b\s*(.*)$/i;
/** "Make subframe the main repository of Operation Ledger". */
const MAIN_REPO_MAKE =
  /^(?:please\s+)?make\s+(.+?)\s+(?:the\s+)?main\s+repo(?:sitory)?(?:\s+(?:of|for|on)\s+(?:the\s+)?(?:operation|op)\b\s*(.*))?$/i;
/** "Change the repo (of Operation Ledger) from demo-app to subframe". */
const MAIN_REPO_CHANGE =
  /^(?:please\s+)?(?:change|switch|move|set)\s+(?:the\s+)?(?:main\s+)?repo(?:sitory)?(?:\s+(?:of|for|on)\s+(?:the\s+)?(?:operation|op)\b\s*(.+?))?(?:\s+from\s+(.+?))?\s+to\s+(.+)$/i;
/** "Move Operation Ledger to subframe". */
const MAIN_REPO_MOVE =
  /^(?:please\s+)?(?:move|switch)\s+(?:the\s+)?(?:operation|op)\b\s*(.+?)\s+(?:over\s+)?(?:to|onto)\s+(?:the\s+)?(.+?)(?:\s+repo(?:sitory)?)?$/i;
/** "Cancel Operation Ledger: wrong approach". */
const CANCEL_OPERATION =
  /^(?:please\s+)?(?:cancel|call off|abort|scrub)\s+(?:the\s+)?(?:operation|op)\b\s*([^:]*?)(?:\s*(?::|—|\bbecause\b)\s*(.+))?$/i;
/** "Restart the queues", "Kick the queues", "Unstick the dispatch". */
const RESTART_QUEUES =
  /^(?:please\s+)?(?:restart|kick|unstick|nudge|re-?run|re-?dispatch)\s+(?:the\s+)?(?:queues?|dispatch(?:er)?|dispatching)\b/i;
/** "Start Operation Ledger over", "Restart Operation Ledger: wrong plan". */
const RESTART_OPERATION =
  /^(?:please\s+)?(?:restart|redo|start)\s+(?:the\s+)?(?:operation|op)\b\s*([^:]*?)(?:\s+(over|again|afresh|from scratch))?(?:\s*(?::|—|\bbecause\b)\s*(.+))?$/i;
/** "Abort the guard mission", "Scrub Guard's mission: wrong brief". */
const ABORT_MISSION =
  /^(?:please\s+)?(?:abort|scrub|withdraw|call off)\s+(?:the\s+)?(.*?)\s*mission\b(?:\s+(?:in|of|for|on)\s+(?:operation|op)\s+([^:—]+?))?(?:\s*(?::|—|\bbecause\b)\s*(.+))?$/i;
/** "Start the guard mission over", "Restart Guard's mission", "Redo the build mission". */
const RESTART_MISSION =
  /^(?:please\s+)?(?:(?:restart|redo)\s+(?:the\s+)?(.*?)\s*mission\b(?:\s+(?:in|of|for|on)\s+(?:operation|op)\s+([^:—]+?))?|start\s+(?:the\s+)?(.*?)\s*mission\b(?:\s+(?:in|of|for|on)\s+(?:operation|op)\s+([^:—]+?))?\s+(?:over|again|afresh|from scratch))(?:\s*(?::|—|\bbecause\b)\s*(.+))?$/i;
/** "…, using payments-service and gpu1" at the end of a statement of intent. */
const INTENT_RESOURCES = /,?\s+(?:using|with|on|against)\s+(?:the\s+|our\s+)?(.+)$/i;
/**
 * "Start a (new) project called X: …", "New project X, a single HTML file that …". The name
 * ends at a colon, comma, dash or quote; what follows is the intent.
 */
const NEW_PROJECT =
  /^(?:(?:please|maybe|perhaps|possibly|let'?s)\s+)*(?:start|create|begin|open|new)\s+(?:a\s+)?(?:new\s+)?(?:single[- ]?(?:html|file)\s+)?project(?:\s+(?:called|named))?\s*["“]?([A-Za-z0-9][A-Za-z0-9 ._-]{0,59}?)["”]?\s*(?:[:,–—-]\s*(.+))?[.!]?$/i;
const KIND_WORDS =
  /\b(repo|repository|repositories|server|environment|env|model|credential|token|key)\b/gi;
const MAIN_EFFORT_CLEAR =
  /\b(no|clear|drop|end|cancel|lift|remove)\b.*\bmain effort\b|\bmain effort\b.*\b(is over|has ended|ended|cleared|lifted)\b/i;
const MAIN_EFFORT_FILLER =
  /\b(make|makes|making|is|are|now|our|the|operation|op|put|first|priority|name|as|be|should|will|from|on)\b/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FRAGO_DROP =
  /\b(drop|stand down|pause|hold off( on)?|put .+ on hold|park|shelve|deprioriti[sz]e)\b|\bfor now\b/i;
const FRAGO_AMEND = /\b(instead|also make sure|make sure|change .+ to)\b/i;
/** "Give E-2 permission", "Refuse the request: …", "Permission granted". */
const PERMISSION_DECISION =
  /\b(give|grant|allow|refuse|deny|decline|approve|reject)\b.*\b(permission|request)\b|\bpermission\b.*\b(granted|given|refused|denied)\b/i;
const PERMISSION_REFUSED = /\b(refuse|refused|deny|denied|decline|reject|no)\b/i;
/** Status reason on a task waiting for permission (set by the task runner). */
const ASKS_PERMISSION = 'Asks permission:';
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
      // "Recon …: how does X work?" is an order to find out, not a question to answer.
      const isQuestion =
        !hedged &&
        !RECON.test(sentence.replace(/^[\w-]+,\s*/, '')) &&
        (/\?\s*$/.test(raw) || QUESTION_START.test(sentence));
      const unit = this.targetUnit(sentence, input);

      if (isQuestion) {
        kinds.add('question');
        answers.push(this.answer(sentence, unit, input));
        continue;
      }
      // Permission (rules of engagement) can be given from any channel, like deploy approvals.
      if (
        PERMISSION_DECISION.test(sentence) &&
        (/\bpermission\b/i.test(sentence) || !DEPLOY_DECISION.test(sentence))
      ) {
        const approve = !PERMISSION_REFUSED.test(sentence);
        const note = /:\s*(.+)$/.exec(sentence)?.[1]?.trim() ?? null;
        const waiting = (unit ? [unit] : input.units).flatMap((u) =>
          u.tasks
            .filter(
              (t) =>
                t.status === 'awaiting-approval' && !!t.statusReason?.startsWith(ASKS_PERMISSION),
            )
            .map((t) => ({ u, t })),
        );
        if (!waiting.length) {
          out.unclear.push(`${raw} — no bot is waiting for permission.`);
        } else if (!approve && !note) {
          out.unclear.push(`${raw} — say why you refuse (“Refuse the request: …”).`);
        } else {
          kinds.add('order');
          for (const { u, t } of waiting)
            out.actions.push({
              kind: 'decide-permission',
              unitId: u.id,
              taskId: t.id,
              approve,
              note,
            });
        }
        continue;
      }
      // Deploy approvals can be given from any channel.
      if (DEPLOY_DECISION.test(sentence)) {
        const approve = /\bapprove\b/i.test(sentence);
        const waiting = (unit ? [unit] : input.units).flatMap((u) =>
          u.tasks
            .filter(
              (t) =>
                t.kind === 'deploy' &&
                t.status === 'awaiting-approval' &&
                !t.statusReason?.startsWith(ASKS_PERMISSION),
            )
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
      if (RESTART_QUEUES.test(sentence)) {
        kinds.add('order');
        out.actions.push({ kind: 'restart-queues', unitId: null });
        continue;
      }
      const course =
        this.operationHold(sentence, input) ??
        this.mainRepository(sentence, input) ??
        this.cancelOperation(sentence, input) ??
        this.restartOperation(sentence, input) ??
        this.missionCourse(sentence, unit, input);
      if (course) {
        if ('unclear' in course) {
          out.unclear.push(course.unclear);
        } else if ('missing' in course) {
          out.missing.push({ what: course.missing, kind: 'supply' });
        } else {
          kinds.add(hedged ? 'musing' : 'order');
          (hedged ? out.musings : out.actions).push(course);
        }
        continue;
      }
      const res = this.resource(sentence, input);
      if (res) {
        if ('unclear' in res) {
          out.unclear.push(res.unclear);
        } else {
          for (const a of res.actions) {
            kinds.add(hedged ? 'musing' : 'order');
            (hedged ? out.musings : out.actions).push(a);
          }
          for (const what of res.missing) {
            out.missing.push({ what, kind: 'supply' });
          }
        }
        continue;
      }
      const rehearse = this.rehearse(sentence, input);
      if (rehearse) {
        if ('unclear' in rehearse) out.unclear.push(rehearse.unclear);
        else {
          kinds.add('order');
          out.actions.push(rehearse);
        }
        continue;
      }
      const effort = this.mainEffort(sentence, input);
      if (effort) {
        if ('unclear' in effort) {
          out.unclear.push(effort.unclear);
        } else if (hedged) {
          kinds.add('musing');
          out.musings.push(effort);
        } else {
          kinds.add('order');
          out.actions.push(effort);
        }
        continue;
      }
      const halt = this.standDown(sentence, input);
      if (halt) {
        if ('unclear' in halt) {
          out.unclear.push(halt.unclear);
        } else if (hedged) {
          kinds.add('musing');
          out.musings.push(halt);
        } else {
          kinds.add('order');
          out.actions.push(halt);
        }
        continue;
      }
      if (!unit) {
        // "Start a new project called Ledger: a ledger that works offline." A repository from a
        // template, a site to deploy it to, and (with the rest of the sentence) the operation.
        const project = NEW_PROJECT.exec(sentence);
        if (!input.channelUnitId && project) {
          const rest = (project[2] ?? '').trim().replace(/[.!]+$/, '');
          const action: ChatAction = {
            kind: 'new-project',
            unitId: null,
            name: project[1]!.trim(),
            projectKind: 'single-html',
            intent: rest ? `${sentenceCase(rest)}.` : null,
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
        // To HQ, an order that names no unit is a statement of intent: launch an operation.
        if (
          !input.channelUnitId &&
          (IMPERATIVE.test(sentence) || /\boperation\b/i.test(sentence))
        ) {
          let text = sentence.replace(/^(launch an? |start an? )?operation[:,]?\s*/i, '');
          // "…, using payments-service and gpu1": resources assigned from the start.
          let supplyIds: string[] = [];
          const using = INTENT_RESOURCES.exec(text);
          if (using) {
            const found = this.depotItems(using[1]!, input);
            if (found.hits.length) {
              supplyIds = found.hits;
              text = text.slice(0, using.index);
              for (const what of found.missing) out.missing.push({ what, kind: 'supply' });
            }
          }
          const intent = sentenceCase(text);
          const action: ChatAction = {
            kind: 'create-operation',
            unitId: null,
            intent: `${intent}.`,
            name: operationName(intent),
            supplyIds,
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

  /**
   * Depot items named in a phrase ("payments-service and the gpu1 server"): the ones found, and
   * what was named but is not in the depot.
   */
  private depotItems(phrase: string, input: InterpretInput) {
    const hits: string[] = [];
    const missing: string[] = [];
    for (const part of phrase.split(/\s*(?:,|\band\b|&)\s*/i)) {
      const name = part
        .replace(/^(?:the|our|a|an)\s+/i, '')
        .replace(KIND_WORDS, '')
        .trim();
      if (!name) continue;
      const plain = (x: string) =>
        x
          .toLowerCase()
          .replace(/[-_.]+/g, ' ')
          .trim();
      const want = topic(plain(name));
      const connected = input.depot.filter((d) => d.connected);
      // The exact name wins; otherwise the best word overlap.
      const exact = connected.find((d) => plain(d.name) === plain(name));
      const hit = exact
        ? { d: exact, score: 1 }
        : connected
            .map((d) => ({ d, score: overlap(want, plain(d.name)) }))
            .sort((a, b) => b.score - a.score)[0];
      // A short name must match whole ("billing-api" is not "ledger-api").
      if (hit && hit.score >= (want.size <= 2 ? 1 : 0.6)) {
        if (!hits.includes(hit.d.id)) hits.push(hit.d.id);
      } else {
        missing.push(part.trim());
      }
    }
    return { hits, missing };
  }

  /** The operation a phrase names, or the only one under way when it names none. */
  private operationNamed(phrase: string, input: InterpretInput) {
    const open = input.operations.filter((o) => o.phase !== 'closed');
    const best = open
      .map((o) => ({ o, score: overlap(topic(o.name), phrase) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 0.5) return best.o;
    return !topic(phrase).size && open.length === 1 ? open[0]! : null;
  }

  /** "Operation Ledger: automatic, nothing holds" / "For Operation Ledger, hold only on critical findings". */
  private operationHold(
    sentence: string,
    input: InterpretInput,
  ): Extract<ChatAction, { kind: 'hold-policy' }> | { unclear: string } | null {
    const m = /\b(?:for |on )?operation\s+([A-Za-z0-9][\w .-]*?)\s*[:,]\s*(.+)$/i.exec(sentence);
    if (!m) return null;
    const rest = m[2]!;
    if (!MENTIONS_HOLD.test(rest) && !HOLD_RESET.test(rest)) return null;
    const op = this.operationNamed(m[1]!, input);
    if (!op) return { unclear: `${sentence} — which operation? None open is called ${m[1]}.` };
    if (HOLD_RESET.test(rest)) {
      return { kind: 'hold-policy', unitId: null, operationId: op.id, policy: null };
    }
    const policy = holdPolicyChange(rest, op.holdPolicy ?? DEFAULT_HOLD_POLICY);
    if (!policy) return null;
    return { kind: 'hold-policy', unitId: null, operationId: op.id, policy };
  }

  /** "Use payments-service for Operation Ledger" / "Take gpu1 off Operation Ledger". */
  private resource(
    sentence: string,
    input: InterpretInput,
  ):
    | {
        actions: Extract<ChatAction, { kind: 'assign-resource' | 'release-resource' }>[];
        missing: string[];
      }
    | { unclear: string }
    | null {
    const assign = RESOURCE_ASSIGN.exec(sentence);
    const release = assign ? null : RESOURCE_RELEASE.exec(sentence);
    const m = assign ?? release;
    if (!m) return null;
    const op = this.operationNamed(m[2] ?? '', input);
    const closed = input.operations.find(
      (o) => o.phase === 'closed' && overlap(topic(o.name), m[2] ?? '') >= 0.5,
    );
    if (!op && closed) return { unclear: `${sentence} — Operation ${closed.name} is closed.` };
    if (!op) {
      const open = input.operations.filter((o) => o.phase !== 'closed');
      return {
        unclear: `${sentence} — which operation? ${open.length ? `Under way: ${open.map((o) => o.name).join(', ')}.` : 'None is under way.'}`,
      };
    }
    const { hits, missing } = this.depotItems(m[1]!, input);
    return {
      actions: hits.map((supplyId) => ({
        kind: assign ? ('assign-resource' as const) : ('release-resource' as const),
        unitId: null,
        operationId: op.id,
        supplyId,
      })),
      missing,
    };
  }

  /** The open operation a phrase names; failing that, the one whose resources include `from`. */
  private operationFor(
    phrase: string,
    from: string | null,
    input: InterpretInput,
  ): InterpretInput['operations'][number] | { unclear: string } {
    const named = this.operationNamed(phrase, input);
    if (named) return named;
    const closed = input.operations.find(
      (o) => o.phase === 'closed' && phrase && overlap(topic(o.name), phrase) >= 0.5,
    );
    if (closed) return { unclear: `Operation ${closed.name} is closed.` };
    const open = input.operations.filter((o) => o.phase !== 'closed');
    if (from && !topic(phrase).size) {
      const ids = this.depotItems(from, input).hits;
      const using = open.filter((o) => ids.some((id) => o.supplyIds?.includes(id)));
      if (using.length === 1) return using[0]!;
    }
    return {
      unclear: `which operation? ${open.length ? `Under way: ${open.map((o) => o.name).join(', ')}.` : 'None is under way.'}`,
    };
  }

  /** "Change the repo from demo-app to subframe" / "Make subframe the main repository of …". */
  private mainRepository(
    sentence: string,
    input: InterpretInput,
  ):
    | Extract<ChatAction, { kind: 'set-main-repository' }>
    | { unclear: string }
    | { missing: string }
    | null {
    const make = MAIN_REPO_MAKE.exec(sentence);
    const change = make ? null : MAIN_REPO_CHANGE.exec(sentence);
    const move = make || change ? null : MAIN_REPO_MOVE.exec(sentence);
    if (!make && !change && !move) return null;
    const [opPhrase, from, to] = make
      ? [make[2] ?? '', null, make[1]!]
      : change
        ? [change[1] ?? '', change[2] ?? null, change[3]!]
        : [move![1]!, null, move![2]!];
    const op = this.operationFor(opPhrase, from, input);
    if ('unclear' in op) return { unclear: `${sentence} — ${op.unclear}` };
    const repos = this.depotItems(to, input).hits.filter(
      (id) => input.depot.find((d) => d.id === id)?.kind === 'repository',
    );
    if (!repos.length) return { missing: to.replace(/[.!]+$/, '').trim() };
    return { kind: 'set-main-repository', unitId: null, operationId: op.id, supplyId: repos[0]! };
  }

  /** "Cancel Operation Ledger: wrong approach". */
  private cancelOperation(
    sentence: string,
    input: InterpretInput,
  ): Extract<ChatAction, { kind: 'cancel-operation' }> | { unclear: string } | null {
    const m = CANCEL_OPERATION.exec(sentence);
    if (!m) return null;
    const op = this.operationFor(m[1] ?? '', null, input);
    if ('unclear' in op) return { unclear: `${sentence} — ${op.unclear}` };
    return {
      kind: 'cancel-operation',
      unitId: null,
      operationId: op.id,
      note: (m[2] ?? '').replace(/[.!]+$/, '').trim(),
    };
  }

  /** "Start Operation Ledger over": every mission withdrawn and issued again. */
  private restartOperation(
    sentence: string,
    input: InterpretInput,
  ): Extract<ChatAction, { kind: 'restart-operation' }> | { unclear: string } | null {
    const m = RESTART_OPERATION.exec(sentence);
    if (!m) return null;
    // "Start Operation X" without "over" is a launch, not a restart.
    if (/^(?:please\s+)?start\b/i.test(sentence) && !m[2]) return null;
    const op = this.operationFor(m[1] ?? '', null, input);
    if ('unclear' in op) return { unclear: `${sentence} — ${op.unclear}` };
    return {
      kind: 'restart-operation',
      unitId: null,
      operationId: op.id,
      note: (m[3] ?? '').replace(/[.!]+$/, '').trim(),
    };
  }

  /** "Abort the guard mission" / "Start Guard's mission over": one mission, named by its unit, stage or goal. */
  private missionCourse(
    sentence: string,
    unit: InterpretUnit | null,
    input: InterpretInput,
  ):
    | Extract<ChatAction, { kind: 'withdraw-mission' | 'restart-mission' }>
    | { unclear: string }
    | null {
    const restart = RESTART_MISSION.exec(sentence);
    const abort = restart ? null : ABORT_MISSION.exec(sentence);
    if (!restart && !abort) return null;
    const phrase = (restart ? (restart[1] ?? restart[3]) : abort![1]) ?? '';
    const opName = (restart ? (restart[2] ?? restart[4]) : abort![2]) ?? '';
    const note = (restart ? restart[5] : abort![3]) ?? '';
    let operationId: string | null = null;
    if (opName.trim()) {
      const op = this.operationFor(opName.trim(), null, input);
      if ('unclear' in op) return { unclear: `${sentence} — ${op.unclear}` };
      operationId = op.id;
    }
    const found = this.missionFor(phrase, unit, input, operationId, !!restart);
    if ('unclear' in found) return { unclear: `${sentence} — ${found.unclear}` };
    return {
      kind: restart ? 'restart-mission' : 'withdraw-mission',
      unitId: found.unitId,
      missionId: found.mission.id,
      note: note.replace(/[.!]+$/, '').trim(),
    };
  }

  /** The mission "the guard mission" / "Guard's mission" / "the rate-limiting mission" means. */
  private missionFor(
    phrase: string,
    unit: InterpretUnit | null,
    input: InterpretInput,
    operationId: string | null,
    restarting: boolean,
  ): { unitId: string; mission: InterpretUnit['missions'][number] } | { unclear: string } {
    const q = phrase
      .replace(/['’]s$/i, '')
      .replace(/^(?:the|this|that|its|their)\s+/i, '')
      .trim()
      .toLowerCase();
    const named = input.units.find((u) => u.name.toLowerCase() === q || u.slug === q);
    const scope = named
      ? [named]
      : unit && !q
        ? [unit]
        : unit
          ? [unit, ...input.units.filter((u) => u !== unit)]
          : input.units;
    // Starting over takes a withdrawn mission too; aborting only one under way.
    const live = scope.flatMap((u) =>
      u.missions
        .filter(
          (x) =>
            x.status !== 'done' &&
            (restarting || x.status !== 'withdrawn') &&
            (!operationId || x.operationId === operationId),
        )
        .map((mission) => ({ unitId: u.id, mission })),
    );
    if (!live.length)
      return { unclear: `no mission is under way${named ? ` for ${named.name}` : ''}.` };
    if ((named || operationId) && live.length === 1) return live[0]!;
    if (q) {
      const byStage = live.filter((x) => (x.mission.stage ?? '').toLowerCase() === q);
      if (byStage.length === 1) return byStage[0]!;
      const best = live
        .map((x) => ({ x, score: overlap(topic(x.mission.goal), q) }))
        .sort((a, b) => b.score - a.score)[0]!;
      if (best.score >= 0.5) return best.x;
    } else if (live.length === 1) {
      return live[0]!;
    }
    return {
      unclear: `which mission? Under way: ${live
        .map((x) => `“${x.mission.goal}” (${input.units.find((u) => u.id === x.unitId)?.name})`)
        .join(', ')}.`,
    };
  }

  /** "Rehearse Gatekeeper on the sand table": changes nothing, so never a musing. */
  private rehearse(
    sentence: string,
    input: InterpretInput,
  ): Extract<ChatAction, { kind: 'rehearse' }> | { unclear: string } | null {
    if (!REHEARSE.test(sentence)) return null;
    const open = input.operations.filter((o) => o.phase !== 'closed');
    if (!open.length) return { unclear: `${sentence} — there is no operation to rehearse.` };
    const best = open
      .map((o) => ({ o, score: overlap(topic(o.name), sentence) }))
      .sort((a, b) => b.score - a.score)[0]!;
    const op = best.score >= 0.5 ? best.o : open.length === 1 ? open[0]! : null;
    if (!op)
      return {
        unclear: `${sentence} — which operation? Under way: ${open.map((o) => o.name).join(', ')}.`,
      };
    return { kind: 'rehearse', unitId: null, operationId: op.id };
  }

  /**
   * "Make Login Rate Limiting the main effort" / "No main effort any more". Main effort is
   * HQ's business: the action names an operation, not a unit.
   */
  private mainEffort(
    sentence: string,
    input: InterpretInput,
  ): Extract<ChatAction, { kind: 'main-effort' }> | { unclear: string } | null {
    if (!MAIN_EFFORT.test(sentence)) return null;
    const why = REASON.exec(sentence);
    const body = why ? sentence.slice(0, why.index) : sentence;
    const reason = why ? sentenceCase(stripEnd(why[2]!)) : 'Commander’s order in chat';
    const current = input.mainEffortOperationId ?? null;
    if (MAIN_EFFORT_CLEAR.test(body)) {
      if (!current) return { unclear: `${sentence} — there is no main effort.` };
      return { kind: 'main-effort', unitId: null, operationId: null, reason };
    }
    const open = input.operations.filter((o) => o.phase !== 'closed');
    if (!open.length) return { unclear: `${sentence} — there is no operation under way.` };
    const rest = topic(body.replace(MAIN_EFFORT, ' ').replace(MAIN_EFFORT_FILLER, ' '));
    const best = open
      .map((o) => ({ o, score: overlap(topic(o.name), body) }))
      .sort((a, b) => b.score - a.score)[0]!;
    const op = best.score >= 0.5 ? best.o : !rest.size && open.length === 1 ? open[0]! : null;
    if (!op) {
      return {
        unclear: `${sentence} — which operation? Under way: ${open.map((o) => o.name).join(', ')}.`,
      };
    }
    if (op.id === current)
      return { unclear: `${sentence} — ${op.name} is already the main effort.` };
    return { kind: 'main-effort', unitId: null, operationId: op.id, reason };
  }

  /**
   * "Stand down everything" / "Engineers, stand down" / "E-2, stand down" and "Resume work".
   * Returns null when the sentence is about particular work ("stand down the mobile
   * layout"): that is a frago, handled with the unit's other orders.
   */
  private standDown(
    sentence: string,
    input: InterpretInput,
  ): Extract<ChatAction, { kind: 'stand-down' | 'lift-stand-down' }> | { unclear: string } | null {
    const lift = LIFT.test(sentence);
    if (!lift && !STAND_DOWN.test(sentence)) return null;
    const why = REASON.exec(sentence);
    let rest = (why ? sentence.slice(0, why.index) : sentence)
      .replace(lift ? LIFT : STAND_DOWN, ' ')
      .replace(EVERYTHING, ' ')
      .replace(HEDGE, ' ');
    const all = EVERYTHING.test(sentence);
    const hit = input.units
      .flatMap((u) => u.bots.map((b) => ({ u, b })))
      .find(({ b }) => new RegExp(`\\b${escapeRe(b.callsign)}\\b`, 'i').test(sentence));
    const named = input.units.find((u) =>
      new RegExp(`\\b${escapeRe(u.name)}\\b`, 'i').test(sentence),
    );
    if (hit) rest = rest.replace(new RegExp(`\\b${escapeRe(hit.b.callsign)}\\b`, 'gi'), ' ');
    if (named) rest = rest.replace(new RegExp(`\\b${escapeRe(named.name)}\\b`, 'gi'), ' ');
    if ([...topic(rest)].some((w) => !SCOPE_WORDS.has(w))) return null;

    const reason = why ? sentenceCase(stripEnd(why[2]!)) : 'Commander’s order in chat';
    const kind = lift ? 'lift-stand-down' : 'stand-down';
    const unit = named ?? input.units.find((u) => u.id === input.channelUnitId) ?? null;
    if (all || (!unit && !hit)) {
      if (!all && !lift) {
        return {
          unclear: `${sentence} — stand down which unit? Say “everything” to stop all units.`,
        };
      }
      if (lift && !input.allHalted) {
        const halted = input.units.filter((u) => u.halted).map((u) => u.name);
        if (!halted.length) return { unclear: `${sentence} — nothing is stood down.` };
        return {
          unclear: `${sentence} — only ${halted.join(', ')} ${halted.length > 1 ? 'are' : 'is'} stood down: name the unit.`,
        };
      }
      if (!lift && input.allHalted)
        return { unclear: `${sentence} — all units are already stood down.` };
      return { kind, unitId: null, scope: 'all', targetId: null, reason };
    }
    if (hit) {
      if (lift === !hit.b.halted) {
        if (lift && (hit.u.halted || input.allHalted))
          return {
            unclear: `${sentence} — ${hit.b.callsign} is stood down with ${input.allHalted ? 'all units' : hit.u.name}: lift that order.`,
          };
        return {
          unclear: `${sentence} — ${hit.b.callsign} is ${lift ? 'not' : 'already'} stood down.`,
        };
      }
      return { kind, unitId: hit.u.id, scope: 'bot', targetId: hit.b.id, reason };
    }
    const u = unit!;
    if (lift && !u.halted) {
      if (input.allHalted)
        return { unclear: `${sentence} — all units are stood down: say “Everyone, resume work”.` };
      const bots = u.bots.filter((b) => b.halted);
      if (bots.length === 1) {
        return { kind, unitId: u.id, scope: 'bot', targetId: bots[0]!.id, reason };
      }
      return { unclear: `${sentence} — ${u.name} is not stood down.` };
    }
    if (!lift && u.halted) return { unclear: `${sentence} — ${u.name} is already stood down.` };
    return { kind, unitId: u.id, scope: 'unit', targetId: u.id, reason };
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
    // An issue from a connected tracker, taken on as a mission.
    const issue = TAKE_ISSUE.exec(sentence);
    if (issue) {
      const tracker = input.trackers?.[0];
      if (!tracker) return { missing: { what: 'an issue tracker', kind: 'supply' } };
      return {
        kind: 'order',
        action: {
          kind: 'take-issue',
          unitId: unit.id,
          connectionId: tracker.id,
          number: Number(issue[1]),
        },
      };
    }
    // Recon: a read-only survey that answers a question.
    const recon = RECON.exec(sentence);
    if (recon) {
      let q = sentence.slice(recon[0].length);
      let repoSupplyId: string | null = null;
      const named = /^(?:the\s+|our\s+)?([\w-]+)\s+(?:repo|repository)\b[:,;—-]?\s*/i.exec(q);
      if (named) {
        const repo = input.depot.find(
          (d) =>
            d.kind === 'repository' && d.name.toLowerCase().startsWith(named[1]!.toLowerCase()),
        );
        if (!repo || !repo.connected)
          return { missing: { what: `a repository named “${named[1]}”`, kind: 'repository' } };
        repoSupplyId = repo.id;
        q = q.slice(named[0].length);
      }
      q = q.replace(/^(for|on|into|about)\s+/i, '').trim();
      if (!q) return { unclear: `${sentence} — recon for what? Say what to find out.` };
      return {
        kind: 'order',
        action: { kind: 'recon', unitId: unit.id, question: sentenceCase(q), repoSupplyId },
      };
    }
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
    // The hold policy: what the unit fixes alone, and what holds the work for the Commander.
    const hold = holdPolicyChange(sentence, unit.holdPolicy);
    if (hold) {
      return {
        kind: 'rule-change',
        action: { kind: 'hold-policy', unitId: unit.id, operationId: null, policy: hold },
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
    if (MAIN_EFFORT.test(sentence)) {
      const op = input.operations.find((o) => o.id === input.mainEffortOperationId);
      return op
        ? `The main effort is Operation ${op.name} (${op.phase}): its tasks go first.`
        : 'There is no main effort: work goes in normal queue order.';
    }
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
