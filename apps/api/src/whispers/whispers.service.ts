import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { WhisperView } from '@orbot/shared';
import { RedactionService } from '../redaction/redaction.service.js';

/** How many notes the board holds; the oldest make way. */
export const BOARD_MAX = 60;
/** How many whispers a bot overhears in one brief. */
export const OVERHEARD_MAX = 5;
/** Nothing stays longer than this, whatever the dice say. */
const LONGEST_MS = 48 * 60 * 60 * 1000;
/** The dice are thrown this often (and whenever a note is left). */
const SWEEP_MS = 10 * 60 * 1000;

/**
 * The whispers board: gossip, as a human group has it. Anyone (an officer at the
 * page, a bot through its `whisper` tool) leaves an unsigned note that anyone can read;
 * bots overhear a handful in their brief and are told to use what helps without ever
 * saying so. None of it is the record: the board lives in memory only, nothing here is
 * logged or attributed, a restart empties it, and each note fades at random, sooner the
 * older it is. What matters gets verified and recorded by whoever acts on it; the whisper
 * itself never does.
 */
@Injectable()
export class WhispersService implements OnModuleDestroy {
  private notes: (WhisperView & { atMs: number })[] = [];
  private readonly timer: NodeJS.Timeout;
  /** The dice. Tests replace them. */
  random: () => number = Math.random;

  constructor(private readonly redaction: RedactionService) {
    this.timer = setInterval(() => this.fade(), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** The board, newest first. Reading it throws no dice: only the clock does. */
  board(): WhisperView[] {
    this.expire();
    return [...this.notes].reverse().map(({ id, text, at }) => ({ id, text, at }));
  }

  /** Leave a note. Nobody records who did. */
  leave(text: string): WhisperView {
    this.expire();
    const now = Date.now();
    const note = {
      id: randomUUID(),
      text: this.redaction.clean(text.trim()),
      at: new Date(now).toISOString(),
      atMs: now,
    };
    this.notes.push(note);
    while (this.notes.length > BOARD_MAX) this.notes.shift();
    const { id, text: t, at } = note;
    return { id, text: t, at };
  }

  /** A handful for a brief, in no particular order, never the same handful twice. */
  overheard(limit = OVERHEARD_MAX): string[] {
    this.expire();
    const pool = [...this.notes];
    const out: string[] = [];
    while (pool.length && out.length < limit) {
      const i = Math.min(pool.length - 1, Math.floor(this.random() * pool.length));
      out.push(pool.splice(i, 1)[0]!.text);
    }
    return out;
  }

  /** Nothing outlives two days, whatever the dice said. */
  private expire(now = Date.now()): void {
    this.notes = this.notes.filter((n) => now - n.atMs < LONGEST_MS);
  }

  /**
   * Throw the dice, every ten minutes: each note goes with a chance that grows with its age
   * (about one in fifty per sweep when fresh, one in five after a day), and nothing outlives
   * two days. Never thrown on a read, so looking at the board does not wear it out.
   */
  fade(now = Date.now()): void {
    this.expire(now);
    this.notes = this.notes.filter((n) => {
      const chance = 0.02 + ((now - n.atMs) / LONGEST_MS) * 0.36;
      return this.random() >= chance;
    });
  }
}
