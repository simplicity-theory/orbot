import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { git } from '../common/git.js';

export interface DocsLocation {
  /** Repository supply id the documents live in. */
  repoSupplyId: string;
  /** Local clone of that repository. */
  repoPath: string;
  defaultBranch: string;
}

/**
 * Where unit documents are kept as Markdown. Behind an interface so storage can
 * move later (another branch, another repo, a docs service).
 */
export interface UnitDocumentStore {
  /** Branch and folder (inside the repository) the documents live in. */
  describe(loc: DocsLocation, unitSlug: string): { branch: string; path: string };
  read(loc: DocsLocation, unitSlug: string): Promise<Map<string, string>>;
  /** Write files and commit them together. Returns the commit and changed paths (commit null if nothing changed). */
  write(
    loc: DocsLocation,
    unitSlug: string,
    files: Map<string, string>,
    message: string,
  ): Promise<WriteResult>;
}

export interface WriteResult {
  commit: string | null;
  changed: string[];
}

export const DOCS_BRANCH = 'orbot/unit-docs';

/**
 * Keeps each unit's documents in `.orbot/units/<slug>/` on the `orbot/unit-docs`
 * branch of the unit's repository (a dedicated worktree under the workspaces dir),
 * so they are versioned with the code and readable by human developers.
 */
export class GitDocumentStore implements UnitDocumentStore {
  constructor(private readonly workspacesDir: string) {}

  describe(_loc: DocsLocation, unitSlug: string) {
    return { branch: DOCS_BRANCH, path: `.orbot/units/${unitSlug}` };
  }

  private worktree(loc: DocsLocation): string {
    return join(this.workspacesDir, 'docs', loc.repoSupplyId);
  }

  private async ensureWorktree(loc: DocsLocation): Promise<string> {
    const path = this.worktree(loc);
    if (existsSync(path)) return path;
    await mkdir(dirname(path), { recursive: true });
    const branches = await git(loc.repoPath, ['branch', '--list', DOCS_BRANCH]);
    if (branches.trim()) {
      await git(loc.repoPath, ['worktree', 'add', '--quiet', path, DOCS_BRANCH]);
    } else {
      await git(loc.repoPath, [
        'worktree',
        'add',
        '--quiet',
        '-b',
        DOCS_BRANCH,
        path,
        loc.defaultBranch,
      ]);
    }
    return path;
  }

  async read(loc: DocsLocation, unitSlug: string): Promise<Map<string, string>> {
    const root = join(await this.ensureWorktree(loc), this.describe(loc, unitSlug).path);
    const out = new Map<string, string>();
    if (!existsSync(root)) return out;
    const walk = async (dir: string) => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) await walk(p);
        else if (ent.name.endsWith('.md')) out.set(relative(root, p), await readFile(p, 'utf8'));
      }
    };
    await walk(root);
    return out;
  }

  async write(
    loc: DocsLocation,
    unitSlug: string,
    files: Map<string, string>,
    message: string,
  ): Promise<WriteResult> {
    const wt = await this.ensureWorktree(loc);
    const root = join(wt, this.describe(loc, unitSlug).path);
    for (const [rel, content] of files) {
      const p = join(root, rel);
      if (relative(root, p).startsWith('..'))
        throw new Error(`Refusing to write outside the unit folder: ${rel}`);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, 'utf8');
    }
    await git(wt, ['add', '-A', '--', this.describe(loc, unitSlug).path]);
    const prefix = this.describe(loc, unitSlug).path + '/';
    const changed = (await git(wt, ['diff', '--cached', '--name-only']))
      .split('\n')
      .filter(Boolean)
      .map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p));
    if (!changed.length) return { commit: null, changed };
    await git(wt, ['commit', '--quiet', '-m', message]);
    return { commit: await git(wt, ['rev-parse', 'HEAD']), changed };
  }
}
