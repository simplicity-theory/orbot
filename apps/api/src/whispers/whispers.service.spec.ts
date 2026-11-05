import { RedactionService } from '../redaction/redaction.service.js';
import { loadConfig } from '../config/config.js';
import { BOARD_MAX, WhispersService } from './whispers.service.js';

const SECRET = 'hunter2-very-secret-token-value';

function make() {
  const redaction = new RedactionService(
    loadConfig({
      ORBOT_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
      ORBOT_COMMANDER_PASSPHRASE: 'pass-phrase-for-tests',
      ORBOT_SESSION_SECRET: 'session-secret-session-secret-session',
    }),
  );
  redaction.registerSecret('gh-token', SECRET);
  const w = new WhispersService(redaction);
  w.random = () => 1; // nothing fades unless told to
  return w;
}

describe('WhispersService', () => {
  it('a note left is read newest first, unsigned, and never carries a secret', () => {
    const w = make();
    const a = w.leave('  The cold cache makes the first test run slow.  ');
    const b = w.leave(`Use ${SECRET} if you need the token`);
    expect(w.board().map((n) => n.id)).toEqual([b.id, a.id]);
    expect(w.board()[1]).toEqual({
      id: a.id,
      text: 'The cold cache makes the first test run slow.',
      at: a.at,
    });
    expect(w.board()[0]!.text).not.toContain(SECRET);
    expect(Object.keys(w.board()[0]!)).toEqual(['id', 'text', 'at']);
    w.onModuleDestroy();
  });

  it('the board holds so many; the oldest make way', () => {
    const w = make();
    for (let i = 0; i < BOARD_MAX + 5; i++) w.leave(`note ${i}`);
    const texts = w.board().map((n) => n.text);
    expect(texts).toHaveLength(BOARD_MAX);
    expect(texts[0]).toBe(`note ${BOARD_MAX + 4}`);
    expect(texts).not.toContain('note 0');
    w.onModuleDestroy();
  });

  it('notes fade at random, sooner the older, and never outlive two days', () => {
    const w = make();
    w.leave('fresh');
    w.fade();
    expect(w.board()).toHaveLength(1);
    w.random = () => 0.1; // one in ten: a fresh note (2%) stays; one a day old (20%) goes
    w.fade(Date.now());
    expect(w.board()).toHaveLength(1);
    w.fade(Date.now() + 24 * 60 * 60 * 1000);
    expect(w.board()).toHaveLength(0);
    w.random = () => 1;
    w.leave('old enough');
    w.fade(Date.now() + 49 * 60 * 60 * 1000);
    expect(w.board()).toHaveLength(0);
    w.random = () => 0;
    w.leave('gone next sweep');
    w.fade();
    expect(w.board()).toHaveLength(0);
    w.onModuleDestroy();
  });

  it('a brief overhears a handful, not the lot', () => {
    const w = make();
    for (let i = 0; i < 9; i++) w.leave(`note ${i}`);
    w.random = () => 0.99;
    const heard = w.overheard();
    expect(heard).toHaveLength(5);
    expect(new Set(heard).size).toBe(5);
    expect(w.overheard(2)).toHaveLength(2);
    w.onModuleDestroy();
  });
});
