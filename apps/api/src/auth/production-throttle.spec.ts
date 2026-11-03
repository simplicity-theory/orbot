import { describe, expect, it } from 'vitest';
import { LoginThrottle } from './auth.controller.js';

describe('LoginThrottle', () => {
  it('locks an address after too many failures, for the lock period, and a success clears it', () => {
    const t = new LoginThrottle(3, 1000);
    const now = 1_000_000;
    t.failed('a', now);
    t.failed('a', now);
    expect(t.lockedFor('a', now)).toBe(0);
    t.failed('a', now);
    expect(t.lockedFor('a', now)).toBe(1000);
    expect(t.lockedFor('a', now + 500)).toBe(500);
    expect(t.lockedFor('a', now + 1000)).toBe(0);
    // Another address is not affected.
    expect(t.lockedFor('b', now)).toBe(0);
    t.failed('b', now);
    t.succeeded('b');
    t.failed('b', now);
    t.failed('b', now);
    expect(t.lockedFor('b', now)).toBe(0);
  });
});
