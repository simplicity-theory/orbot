import type { DiffHunk, DiffLine, FileDiff } from '@orbot/shared';

export interface DiffLimits {
  /** Files shown at most; the rest are left out (`truncated`). */
  maxFiles: number;
  /** Lines shown per file before it is cut short. */
  maxLinesPerFile: number;
  /** Lines shown across all files. */
  maxLines: number;
}

export const DIFF_LIMITS: DiffLimits = { maxFiles: 200, maxLinesPerFile: 1500, maxLines: 20_000 };

const unquote = (p: string) =>
  p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p;
const strip = (p: string) => unquote(p).replace(/^[ab]\//, '');

/**
 * Parse `git diff` / `git show` patch output (no colour) into files and hunks, with line
 * numbers on each side. Long files and long diffs are cut short and marked `truncated`.
 */
export function parseDiff(
  text: string,
  limits: DiffLimits = DIFF_LIMITS,
): { files: FileDiff[]; truncated: boolean } {
  const files: FileDiff[] = [];
  let truncated = false;
  let shown = 0;
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let left = 0;
  let right = 0;
  let fileLines = 0;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (files.length >= limits.maxFiles) {
        truncated = true;
        file = null;
        continue;
      }
      const m = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line);
      const path = m ? strip(m[2]!) : line.slice(11);
      file = {
        path,
        oldPath: null,
        status: 'modified',
        binary: false,
        added: 0,
        removed: 0,
        hunks: [],
        truncated: false,
      };
      files.push(file);
      hunk = null;
      fileLines = 0;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = unquote(line.slice(12));
      } else if (line.startsWith('rename to ')) file.path = unquote(line.slice(10));
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null')
        file.path = strip(line.slice(4));
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      left = Number(h[1]);
      right = Number(h[2]);
      hunk = { header: line, lines: [] };
      if (!file.truncated) file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const kind = line[0];
    if (kind !== '+' && kind !== '-' && kind !== ' ') continue; // "\ No newline at end of file"
    let l: DiffLine;
    if (kind === '+') {
      file.added++;
      l = { kind: 'added', text: line.slice(1), leftNo: null, rightNo: right++ };
    } else if (kind === '-') {
      file.removed++;
      l = { kind: 'removed', text: line.slice(1), leftNo: left++, rightNo: null };
    } else {
      l = { kind: 'same', text: line.slice(1), leftNo: left++, rightNo: right++ };
    }
    if (file.truncated) continue;
    if (fileLines >= limits.maxLinesPerFile || shown >= limits.maxLines) {
      file.truncated = true;
      if (shown >= limits.maxLines) truncated = true;
      continue;
    }
    hunk.lines.push(l);
    fileLines++;
    shown++;
  }
  return { files, truncated };
}

/** A new file not yet known to git, shown as all added. */
export function addedFile(path: string, content: string, limits = DIFF_LIMITS): FileDiff {
  const binary = content.includes('\0');
  const all = binary ? [] : content.replace(/\n$/, '').split('\n');
  const lines = all
    .slice(0, limits.maxLinesPerFile)
    .map((text, i): DiffLine => ({ kind: 'added', text, leftNo: null, rightNo: i + 1 }));
  return {
    path,
    oldPath: null,
    status: 'added',
    binary,
    added: all.length,
    removed: 0,
    hunks: lines.length ? [{ header: `@@ -0,0 +1,${all.length} @@`, lines }] : [],
    truncated: all.length > lines.length,
  };
}
