import { randomBytes } from 'node:crypto';
import { open, seal } from './crypto.js';

describe('secrets crypto', () => {
  const key = randomBytes(32);

  it('round-trips a value', () => {
    expect(open(key, 'a', seal(key, 'a', 'hunter2'))).toBe('hunter2');
  });

  it('does not store the plaintext', () => {
    expect(seal(key, 'a', 'hunter2-plaintext').ciphertext.toString('utf8')).not.toContain(
      'hunter2',
    );
  });

  it('refuses a ciphertext moved to another name', () => {
    expect(() => open(key, 'b', seal(key, 'a', 'hunter2'))).toThrow();
  });

  it('refuses the wrong key', () => {
    expect(() => open(randomBytes(32), 'a', seal(key, 'a', 'hunter2'))).toThrow();
  });
});
