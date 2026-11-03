import { describe, expect, it } from 'vitest';
import { headline } from './headline.js';

const none = { answer: null, missing: [] };

describe('read-back headline', () => {
  it('a question is answered, with offers beneath; a hedged statement is asked about', () => {
    expect(
      headline({ answer: 'Task #119 is held by its own hold policy.', missing: [] }, 0, [
        { reason: 'offer' },
      ]),
    ).toBe('Task #119 is held by its own hold policy.');
    expect(headline(none, 0, [{ reason: 'musing' }])).toBe('Did you mean that as an order?');
    expect(headline({ answer: 'All quiet.', missing: [] }, 0, [{ reason: 'musing' }])).toBe(
      'Did you mean that as an order?',
    );
    expect(headline(none, 0, [{ reason: 'offer' }])).toBe('I can do this if you say so.');
  });
  it('orders done, irreversible ones held, refusals and missing supply read as before', () => {
    expect(headline(none, 1, [{ reason: 'offer' }])).toBe('Wilco.');
    expect(headline(none, 0, [{ reason: 'irreversible' }, { reason: 'offer' }])).toBe(
      'That cannot be undone. Confirm and I will act.',
    );
    expect(headline(none, 0, [], true)).toBe('Not done: that order is outside your command.');
    expect(headline({ answer: null, missing: [{ what: 'x', kind: 'supply' }] }, 0, [])).toMatch(
      /not in the Supply Depot/,
    );
    expect(headline(none, 0, [])).toMatch(/^Say again/);
  });
});
