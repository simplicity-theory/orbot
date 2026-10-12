/** Small, dependency-free text similarity used to spot duplicate lessons. */

const STOP_WORDS = new Set(
  'a an and are as at be before by for from has have in is it its not of on or so that the this to was were will with when your you'.split(
    ' ',
  ),
);

/** Lower-cased content words, for comparing lessons. */
export function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[`*_#>[\]()]/g, ' ')
      .split(/[^a-z0-9-]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Two lessons this similar are the same lesson. */
export const DUPLICATE_THRESHOLD = 0.5;

/** Short title from a lesson: its first clause, at most eight words. */
export function titleFrom(lesson: string): string {
  const first = lesson
    .split(/[.;:—]|\s-\s/)[0]!
    .replace(/[`*_]/g, '')
    .trim();
  const ws = first.split(/\s+/);
  const t = ws.slice(0, 8).join(' ') + (ws.length > 8 ? '…' : '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
