import { addedFile, parseDiff } from './diff.js';

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@ export function main() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' export { a };',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1 @@',
  '+# hello',
  '\\ No newline at end of file',
  'diff --git a/old.txt b/new.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to new.txt',
  'diff --git a/logo.png b/logo.png',
  'deleted file mode 100644',
  'Binary files a/logo.png and /dev/null differ',
].join('\n');

describe('parseDiff', () => {
  it('reads files, hunks and both sides’ line numbers', () => {
    const { files, truncated } = parseDiff(PATCH);
    expect(truncated).toBe(false);
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ['src/app.ts', 'modified', 2, 1],
      ['README.md', 'added', 1, 0],
      ['new.txt', 'renamed', 0, 0],
      ['logo.png', 'deleted', 0, 0],
    ]);
    expect(files[0]!.hunks[0]!.header).toBe('@@ -1,3 +1,4 @@ export function main() {');
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'same', text: 'const a = 1;', leftNo: 1, rightNo: 1 },
      { kind: 'removed', text: 'const b = 2;', leftNo: 2, rightNo: null },
      { kind: 'added', text: 'const b = 3;', leftNo: null, rightNo: 2 },
      { kind: 'added', text: 'const c = 4;', leftNo: null, rightNo: 3 },
      { kind: 'same', text: 'export { a };', leftNo: 3, rightNo: 4 },
    ]);
    expect(files[2]!.oldPath).toBe('old.txt');
    expect(files[3]!.binary).toBe(true);
  });

  it('cuts long files and long diffs short, and says so', () => {
    const limits = { maxFiles: 3, maxLinesPerFile: 2, maxLines: 100 };
    const { files, truncated } = parseDiff(PATCH, limits);
    expect(files).toHaveLength(3);
    expect(truncated).toBe(true);
    expect(files[0]!.truncated).toBe(true);
    expect(files[0]!.hunks[0]!.lines).toHaveLength(2);
    // Counts stay true even when the lines are cut.
    expect(files[0]!.added).toBe(2);
  });

  it('shows a new untracked file as all added', () => {
    expect(addedFile('notes.md', 'one\ntwo\n')).toMatchObject({
      status: 'added',
      added: 2,
      hunks: [
        {
          lines: [
            { text: 'one', rightNo: 1 },
            { text: 'two', rightNo: 2 },
          ],
        },
      ],
    });
  });
});
