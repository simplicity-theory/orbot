import { describe, expect, it } from 'vitest';
import { DEFAULT_HOLD_POLICY } from './entities.js';
import { decideFinding, describeHoldPolicy, effectiveHoldPolicy } from './hold-policy.js';

describe('hold policy', () => {
  it('by default fixes small findings, records the rest, and holds on high or critical', () => {
    expect(decideFinding(DEFAULT_HOLD_POLICY, 'low', 'small')).toBe('fix');
    expect(decideFinding(DEFAULT_HOLD_POLICY, 'critical', 'small')).toBe('fix');
    expect(decideFinding(DEFAULT_HOLD_POLICY, 'low', 'large')).toBe('record');
    expect(decideFinding(DEFAULT_HOLD_POLICY, 'medium', null)).toBe('record');
    expect(decideFinding(DEFAULT_HOLD_POLICY, 'high', 'large')).toBe('hold');
    expect(decideFinding(DEFAULT_HOLD_POLICY, 'critical', null)).toBe('hold');
  });

  it('automatic never holds; "none" never fixes; "large" fixes anything', () => {
    expect(decideFinding({ holdFrom: 'never', fixUpTo: 'small' }, 'critical', 'large')).toBe(
      'record',
    );
    expect(decideFinding({ holdFrom: 'never', fixUpTo: 'small' }, 'critical', null)).toBe('record');
    expect(decideFinding({ holdFrom: 'low', fixUpTo: 'none' }, 'low', 'small')).toBe('hold');
    expect(decideFinding({ holdFrom: 'high', fixUpTo: 'large' }, 'critical', 'large')).toBe('fix');
  });

  it('an operation’s override wins over the unit’s policy', () => {
    const unit = { holdFrom: 'high', fixUpTo: 'small' } as const;
    expect(effectiveHoldPolicy(unit, null)).toBe(unit);
    expect(effectiveHoldPolicy(unit, { holdFrom: 'never', fixUpTo: 'large' })).toEqual({
      holdFrom: 'never',
      fixUpTo: 'large',
    });
  });

  it('describes itself in a sentence', () => {
    expect(describeHoldPolicy(DEFAULT_HOLD_POLICY)).toBe(
      'Findings with a small fix are fixed on the spot, the rest recorded; a high or worse finding that is not fixed holds the work for the Commander.',
    );
    expect(describeHoldPolicy({ holdFrom: 'never', fixUpTo: 'large' })).toBe(
      'Findings are fixed on the spot whatever the size of the fix; nothing ever holds the work (automatic).',
    );
    expect(describeHoldPolicy({ holdFrom: 'low', fixUpTo: 'none' })).toBe(
      'Findings are recorded, never fixed by the bot; any finding that is not fixed holds the work for the Commander.',
    );
  });
});
