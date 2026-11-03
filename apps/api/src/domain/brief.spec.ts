import { describe, expect, it } from 'vitest';
import { brief } from './views.service.js';

describe('brief: a reason cut to its first sentence', () => {
  it('keeps one sentence, cuts long ones, and copes with nothing', () => {
    expect(brief('Upstream API client is not available yet. Tried the registry.')).toBe(
      'Upstream API client is not available yet.',
    );
    // Too short to be the whole story: the next sentence comes along.
    expect(brief('No key. Issue one from the depot. Then resume.')).toBe(
      'No key. Issue one from the depot.',
    );
    expect(brief('x'.repeat(200), 50)).toHaveLength(50);
    expect(brief(null)).toBe('');
  });
});
