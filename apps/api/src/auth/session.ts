import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Principal } from '@orbot/shared';

export const SESSION_COOKIE = 'orbot_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface SessionPayload {
  sub: string;
  kind: Principal['kind'];
  name: string;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signSession(secret: string, p: Principal, now = Date.now()): string {
  const payload: SessionPayload = { sub: p.id, kind: p.kind, name: p.displayName, exp: now + SESSION_TTL_MS };
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(createHmac('sha256', secret).update(body).digest())}`;
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): Principal | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (p.exp < now) return null;
    return { kind: p.kind, id: p.sub, displayName: p.name };
  } catch {
    return null;
  }
}

export function passphraseMatches(expected: string, given: string): boolean {
  const a = createHmac('sha256', 'orbot').update(expected).digest();
  const b = createHmac('sha256', 'orbot').update(given).digest();
  return timingSafeEqual(a, b);
}

/** The single Commander for now. Additional officers with ranks come later. */
export const COMMANDER: Principal = { kind: 'commander', id: 'commander', displayName: 'Commander' };

export function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
