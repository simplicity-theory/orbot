/**
 * The redaction layer. Sits in front of every write to the record, every log
 * line, every API response, every WebSocket message and every error message.
 *
 * Two kinds of detection:
 *  1. Known secrets: exact values held in the secrets store (plus common
 *     encodings of them). Masked as `[REDACTED:secret]`.
 *  2. Patterns: things that look like secrets even if we don't hold them
 *     (private keys, provider tokens, `password=…`, high-entropy blobs).
 *
 * The mask never includes any part of the value.
 */

export interface RedactionFinding {
  detector: string;
}

export interface RedactionResult<T> {
  value: T;
  findings: RedactionFinding[];
}

export interface KnownSecretSource {
  /** Current secret values. Called on every redaction, so keep it cheap. */
  values(): Iterable<string>;
}

interface PatternDetector {
  name: string;
  regex: RegExp;
  /** Index of the capture group holding the secret; 0 = whole match. */
  group?: number;
}

const MIN_KNOWN_SECRET_LENGTH = 4;

const PATTERNS: PatternDetector[] = [
  {
    name: 'private-key',
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: 'openai-key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'gitlab-token', regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe-key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    name: 'url-credentials',
    // scheme://user:PASSWORD@host
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi,
    group: 1,
  },
  {
    name: 'bearer-token',
    regex: /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/g,
    group: 1,
  },
  {
    name: 'assignment',
    // password = hunter2 / "apiKey": "abc…" / token: abc…
    regex:
      /\b(?:pass(?:word|wd|phrase)?|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"',;}{)]{4,})/gi,
    group: 1,
  },
];

/** Object keys whose string values are always secret, whatever they look like. */
const SECRET_KEYS = new Set(
  [
    'password',
    'passwd',
    'passphrase',
    'secret',
    'secretvalue',
    'clientsecret',
    'token',
    'accesstoken',
    'refreshtoken',
    'authtoken',
    'apikey',
    'accesskey',
    'secretkey',
    'privatekey',
    'authorization',
    'cookie',
    'setcookie',
  ],
);

const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksHighEntropy(token: string): boolean {
  // Paths and URLs: judge each segment on its own, so `/tmp/orbot-ws-pGQW0L/repos/<uuid>`
  // is not mistaken for a key. (Known secrets are still caught by exact match.)
  if (token.includes('/')) {
    return token.split('/').some((seg) => seg.length >= 20 && looksHighEntropy(seg));
  }
  if (UUID.test(token) || HEX.test(token)) return false; // ids and git SHAs
  if (/^[a-z_-]+$/i.test(token)) return false; // words / slugs
  if (/^[0-9]+$/.test(token)) return false;
  const classes =
    Number(/[a-z]/.test(token)) + Number(/[A-Z]/.test(token)) + Number(/[0-9]/.test(token));
  if (classes < 3) return false;
  return shannonEntropy(token) >= 4.2;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodingsOf(secret: string): string[] {
  const out = new Set<string>([secret]);
  const b64 = toBase64(secret);
  if (b64) {
    out.add(b64);
    out.add(b64.replace(/=+$/, ''));
    out.add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  }
  try {
    out.add(encodeURIComponent(secret));
  } catch {
    /* lone surrogate: ignore */
  }
  out.add(JSON.stringify(secret).slice(1, -1));
  return [...out].filter((v) => v.length >= MIN_KNOWN_SECRET_LENGTH);
}

function toBase64(s: string): string | null {
  const g = globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } }; btoa?: (s: string) => string };
  if (g.Buffer) return g.Buffer.from(s, 'utf8').toString('base64');
  if (g.btoa) {
    try {
      return g.btoa(unescape(encodeURIComponent(s)));
    } catch {
      return null;
    }
  }
  return null;
}

export const KNOWN_SECRET_MASK = '[REDACTED:secret]';
export const mask = (detector: string) => `[REDACTED:${detector}]`;

export class Redactor {
  private cachedKey = '';
  private cachedRegex: RegExp | null = null;

  constructor(private readonly known: KnownSecretSource = { values: () => [] }) {}

  /** Redact a single string. */
  redactString(input: string): RedactionResult<string> {
    const findings: RedactionFinding[] = [];
    let text = input;

    const knownRegex = this.knownSecretsRegex();
    if (knownRegex) {
      text = text.replace(knownRegex, () => {
        findings.push({ detector: 'known-secret' });
        return KNOWN_SECRET_MASK;
      });
    }

    for (const p of PATTERNS) {
      p.regex.lastIndex = 0;
      text = text.replace(p.regex, (match: string, ...groups: unknown[]) => {
        const g = p.group ? (groups[p.group - 1] as string | undefined) : undefined;
        if (p.group && !g) return match;
        if ((g ?? match).startsWith('[REDACTED')) return match;
        findings.push({ detector: p.name });
        return g ? match.replace(g, mask(p.name)) : mask(p.name);
      });
    }

    text = text.replace(HIGH_ENTROPY_TOKEN, (token) => {
      if (!looksHighEntropy(token)) return token;
      findings.push({ detector: 'high-entropy' });
      return mask('high-entropy');
    });

    return { value: text, findings };
  }

  /**
   * Redact every string inside a JSON-like value. Values under secret-looking
   * keys (`password`, `token`, …) are masked outright.
   */
  redactDeep<T>(input: T): RedactionResult<T> {
    const findings: RedactionFinding[] = [];
    const seen = new WeakMap<object, unknown>();

    const walk = (v: unknown, key: string | null): unknown => {
      if (typeof v === 'string') {
        if (key && SECRET_KEYS.has(key.toLowerCase().replace(/[_-]/g, '')) && v.length > 0) {
          if (v.startsWith('[REDACTED')) return v;
          findings.push({ detector: `secret-field:${key}` });
          return mask('field');
        }
        const r = this.redactString(v);
        findings.push(...r.findings);
        return r.value;
      }
      if (v === null || typeof v !== 'object') return v;
      if (v instanceof Date) return v;
      if (seen.has(v)) return seen.get(v);
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        seen.set(v, out);
        for (const item of v) out.push(walk(item, null));
        return out;
      }
      if (v instanceof Error) {
        const e = new Error(walk(v.message, null) as string);
        e.name = v.name;
        e.stack = typeof v.stack === 'string' ? (walk(v.stack, null) as string) : undefined;
        return e;
      }
      // Only redact plain data objects; leave class instances (streams, buffers) alone.
      const proto = Object.getPrototypeOf(v) as object | null;
      if (proto !== Object.prototype && proto !== null) return v;
      const out: Record<string, unknown> = {};
      seen.set(v, out);
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, k);
      return out;
    };

    const value = walk(input, null) as T;
    return { value, findings };
  }

  private knownSecretsRegex(): RegExp | null {
    const variants = new Set<string>();
    for (const s of this.known.values()) {
      if (s.length < MIN_KNOWN_SECRET_LENGTH) continue;
      for (const v of encodingsOf(s)) variants.add(v);
    }
    if (variants.size === 0) return null;
    // Longest first so an encoding that contains the raw value is masked whole.
    const sorted = [...variants].sort((a, b) => b.length - a.length);
    const key = sorted.join('\u0000');
    if (key !== this.cachedKey || !this.cachedRegex) {
      this.cachedKey = key;
      this.cachedRegex = new RegExp(sorted.map(escapeRegExp).join('|'), 'g');
    }
    this.cachedRegex.lastIndex = 0;
    return this.cachedRegex;
  }
}

export function detectorsOf(findings: RedactionFinding[]): string[] {
  return [...new Set(findings.map((f) => f.detector))].sort();
}
