import type { Interpretation } from '@orbot/shared';

export type PendingReason = 'musing' | 'offer' | 'irreversible';

/**
 * The one line that leads a read-back. A question is answered in it, with the Overseer's
 * offers listed beneath; only a hedged statement earns "Did you mean that as an order?" (D118).
 */
export function headline(
  i: Pick<Interpretation, 'answer' | 'missing'>,
  items: number,
  pending: { reason: PendingReason }[],
  refused = false,
): string {
  // An order carried out: the answer, if the Overseer gave one, says what it did; else Wilco.
  if (items) return i.answer || 'Wilco.';
  if (refused && !pending.length) return 'Not done: that order is outside your command.';
  if (pending.some((p) => p.reason === 'irreversible'))
    return 'That cannot be undone. Confirm and I will act.';
  if (i.answer && pending.length && pending.every((p) => p.reason === 'offer')) return i.answer;
  if (pending.some((p) => p.reason === 'musing')) return 'Did you mean that as an order?';
  if (i.missing.length) return 'I cannot do that yet: it is not in the Supply Depot.';
  if (i.answer) return i.answer;
  if (pending.length) return 'I can do this if you say so.';
  return 'Say again? I did not catch an order or a question.';
}
