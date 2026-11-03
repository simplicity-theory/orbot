import { z } from 'zod';
import { HoldPolicy, Id } from '../domain/entities.js';

/** What a Commander's message is, sentence by sentence. A message can be several at once. */
export const MessageKind = z.enum([
  'question',
  'order',
  'frago',
  'rule-change',
  'supply-grant',
  'musing',
]);
export type MessageKind = z.infer<typeof MessageKind>;

/** `hq` or a unit id. */
export const ChatChannel = z.union([z.literal('hq'), Id]);
export type ChatChannel = z.infer<typeof ChatChannel>;

export const RoeLine = z.object({
  list: z.enum(['mayDoAlone', 'mustEscalate']),
  text: z.string().min(1),
});

/**
 * Everything chat can change. Closed and typed: the interpreter can only emit these,
 * and each runs through the same services the UI uses. No free-text side effects.
 */
export const ChatAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create-mission'),
    unitId: Id,
    goal: z.string().min(1).max(500),
    definitionOfDone: z.array(z.string().min(1)).min(1),
  }),
  z.object({ kind: z.literal('withdraw-mission'), unitId: Id, missionId: Id, note: z.string() }),
  z.object({
    kind: z.literal('frago'),
    unitId: Id,
    change: z.enum(['stand-down', 'amend']),
    taskIds: z.array(Id).min(1),
    note: z.string().min(1),
  }),
  z.object({
    kind: z.literal('resume'),
    unitId: Id,
    taskIds: z.array(Id).min(1),
    note: z.string(),
  }),
  z.object({
    kind: z.literal('rule-change'),
    unitId: Id,
    /** Standing-order ids to remove. */
    removeOrders: z.array(z.string()),
    /** Standing-order texts to add. */
    addOrders: z.array(z.string().min(1)),
    removeRoe: z.array(RoeLine).default([]),
    addRoe: z.array(RoeLine).default([]),
  }),
  z.object({ kind: z.literal('supply-grant'), unitId: Id, supplyId: Id }),
  z.object({ kind: z.literal('supply-revoke'), unitId: Id, supplyId: Id }),
  z.object({ kind: z.literal('budget-grant'), unitId: Id, units: z.number() }),
  /** Through HQ: launch an operation from a statement of intent. */
  z.object({
    kind: z.literal('create-operation'),
    unitId: Id.nullable(),
    intent: z.string().min(1).max(1000),
    name: z.string().min(1).max(100),
    /** Depot items to assign to it from the start (repositories first). */
    supplyIds: z.array(Id).default([]),
  }),
  /** Through HQ: assign a depot item to an operation. A missing required one blocks it. */
  z.object({
    kind: z.literal('assign-resource'),
    unitId: Id.nullable(),
    operationId: Id,
    supplyId: Id,
  }),
  /** Through HQ: take a depot item off an operation (units that hold it keep it). */
  z.object({
    kind: z.literal('release-resource'),
    unitId: Id.nullable(),
    operationId: Id,
    supplyId: Id,
  }),
  /**
   * Through HQ: make a repository the operation's main one (where work lands and deploys from).
   * Once missions are out they are withdrawn and issued again there; work done stays on record.
   */
  z.object({
    kind: z.literal('set-main-repository'),
    unitId: Id.nullable(),
    operationId: Id,
    supplyId: Id,
  }),
  /** Through HQ: call an operation off. Its work stands down; it closes without a review. */
  z.object({
    kind: z.literal('cancel-operation'),
    unitId: Id.nullable(),
    operationId: Id,
    note: z.string().max(500).default(''),
  }),
  /** Start a mission over: withdrawn, then issued again to its unit, which briefs back afresh. */
  z.object({
    kind: z.literal('restart-mission'),
    unitId: Id,
    missionId: Id,
    note: z.string().max(500).default(''),
  }),
  /** Through HQ: start an operation over: every mission withdrawn and issued again from the same plan. */
  z.object({
    kind: z.literal('restart-operation'),
    unitId: Id.nullable(),
    operationId: Id,
    note: z.string().max(500).default(''),
  }),
  /** Land a task's branch on its repository's default branch (the Commander's, never a bot's). */
  z.object({ kind: z.literal('land-task'), unitId: Id, taskId: Id }),
  /** Through HQ: queue again every task shown working with no run behind it, and dispatch every unit. */
  z.object({ kind: z.literal('restart-queues'), unitId: Id.nullable() }),
  /** Approve (or reject) a production deploy waiting on the Commander. */
  z.object({ kind: z.literal('approve-deploy'), unitId: Id, taskId: Id, approve: z.boolean() }),
  /** Decide what a bot asked permission for under its unit's rules of engagement. */
  z.object({
    kind: z.literal('decide-permission'),
    unitId: Id,
    taskId: Id,
    approve: z.boolean(),
    note: z.string().nullable().default(null),
  }),
  /** Stand down one bot, one unit, or everything (`scope: 'all'`). Work pauses with a handover. */
  z.object({
    kind: z.literal('stand-down'),
    unitId: Id.nullable(),
    scope: z.enum(['all', 'unit', 'bot']),
    /** Unit or bot id; null for `all`. */
    targetId: Id.nullable(),
    reason: z.string().min(1),
  }),
  /** Lift a stand-down order: paused work goes back in the queue. */
  z.object({
    kind: z.literal('lift-stand-down'),
    unitId: Id.nullable(),
    scope: z.enum(['all', 'unit', 'bot']),
    targetId: Id.nullable(),
    reason: z.string().min(1),
  }),
  /** Through HQ: rehearse an operation's plan on the sand table (changes nothing). */
  z.object({ kind: z.literal('rehearse'), unitId: Id.nullable(), operationId: Id }),
  /** Take an issue from a connected tracker on as a mission for the unit. */
  z.object({
    kind: z.literal('take-issue'),
    unitId: Id,
    connectionId: Id,
    number: z.number().int().positive(),
  }),
  /** Send a bot to survey the code and report back, changing nothing. */
  z.object({
    kind: z.literal('recon'),
    unitId: Id,
    question: z.string().min(1).max(1000),
    repoSupplyId: Id.nullable(),
  }),
  /** Through HQ: name the operation the force puts first (or, with null, none). */
  z.object({
    kind: z.literal('main-effort'),
    unitId: Id.nullable(),
    operationId: Id.nullable(),
    reason: z.string().min(1),
  }),
  /** Issue a production environment to a unit: deploy rights. Irreversible by default. */
  z.object({ kind: z.literal('grant-deploy-rights'), unitId: Id, supplyId: Id }),
  /**
   * What holds the work: a unit's policy (unitId), or an operation's override (operationId;
   * policy null = back to each unit's own).
   */
  z.object({
    kind: z.literal('hold-policy'),
    unitId: Id.nullable(),
    operationId: Id.nullable(),
    policy: HoldPolicy.nullable(),
  }),
  /**
   * Through HQ: start a new project. A repository from a template and a static site to deploy
   * it to; with an intent, the operation that builds it.
   */
  z.object({
    kind: z.literal('new-project'),
    unitId: Id.nullable(),
    name: z.string().min(1).max(60),
    projectKind: z.enum(['single-html']),
    intent: z.string().min(1).max(1000).nullable(),
  }),
]);
export type ChatAction = z.infer<typeof ChatAction>;
export type ChatActionKind = ChatAction['kind'];
export const CHAT_ACTION_KINDS = ChatAction.options.map(
  (o) => o.shape.kind.value,
) as ChatActionKind[];

/** What the Overseer made of a message. Produced by `BotRuntime.interpret`. */
export const Interpretation = z.object({
  kinds: z.array(MessageKind),
  /** Answer to a question, or anything the Overseer wants to say. */
  answer: z.string().nullable(),
  /** Changes to make now (irreversible ones are still held for confirmation by ORBOT). */
  actions: z.array(ChatAction),
  /** Hedged statements ("I might…"): nothing happens until the Commander says it was an order. */
  musings: z.array(ChatAction),
  /** Promised supply that isn't connected in the depot. */
  missing: z.array(
    z.object({
      what: z.string(),
      kind: z.enum(['repository', 'credential', 'environment', 'supply']),
    }),
  ),
  /** Sentences the Overseer could not turn into anything. */
  unclear: z.array(z.string()),
});
export type Interpretation = z.infer<typeof Interpretation>;

export interface ChatLink {
  label: string;
  link: string;
}

export const SendChatRequest = z.object({
  text: z.string().trim().min(1).max(5000),
});
export type SendChatRequest = z.input<typeof SendChatRequest>;

export const ConfirmPendingRequest = z.object({
  /** Required for irreversible orders: must equal the confirmation phrase. */
  phrase: z.string().trim().max(200).optional(),
});
export type ConfirmPendingRequest = z.input<typeof ConfirmPendingRequest>;
