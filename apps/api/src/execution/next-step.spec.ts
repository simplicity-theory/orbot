import { describe, expect, it } from 'vitest';
import { nextStep } from './task-runner.js';

const fresh = { status: 'working' as const, statusReason: null };

describe('nextStep: what the Commander can do about a task that stopped short', () => {
  it('is the bot’s own suggestion when it gave one', () => {
    expect(nextStep('blocked', 'No key.', fresh, 'Issue the key, then Resume.', false)).toBe(
      'Issue the key, then Resume.',
    );
  });
  it('else the usual way out for a hold, a failure and a crash', () => {
    expect(nextStep('blocked', 'x', fresh, null, false)).toMatch(/then Resume the task/);
    expect(nextStep('failed', 'x', fresh, null, false)).toMatch(/Retry the task or reassign/);
    expect(nextStep('failed', 'x', fresh, null, true)).toMatch(/keeps crashing/);
  });
  it('warns first when the task stopped the same way last time', () => {
    const before = { status: 'blocked' as const, statusReason: 'No key.' };
    expect(nextStep('blocked', 'No key.', before, 'Issue the key.', false)).toBe(
      'Held again for the same reason: resuming alone will not clear it. Issue the key.',
    );
    expect(nextStep('blocked', 'Another reason.', before, 'Issue the key.', false)).toBe(
      'Issue the key.',
    );
    expect(
      nextStep(
        'failed',
        'Tests fail.',
        { status: 'failed', statusReason: 'Tests fail.' },
        null,
        false,
      ),
    ).toMatch(/^Failed again in the same way: retrying alone will not fix it\. /);
  });
  it('is nothing for a task that finished or was stood down', () => {
    expect(nextStep('done', 'Done.', fresh, null, false)).toBeNull();
    expect(nextStep('stood-down', 'Halt.', fresh, 'x', false)).toBeNull();
  });
});
