import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { SupplyBody, TaskBody, Workspace } from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { git } from '../common/git.js';

type RepoSpec = Extract<SupplyBody['spec'], { kind: 'repository' }>;

/**
 * Gives every task its own git worktree on its own branch. In an operation, tasks are
 * cut from the operation's integration branch, and finished work is merged back into
 * it so the next unit picks up exactly what the previous one delivered.
 * Worktrees and branches are never removed.
 */
@Injectable()
export class WorkspaceManager {
  /** One git operation at a time per repository. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  branchFor(task: Pick<TaskBody, 'number'>): string {
    return `orbot/task-${task.number}`;
  }

  private repo(s: SupplyBody): RepoSpec {
    if (s.spec.kind !== 'repository') throw new Error('Workspace needs a repository supply.');
    return s.spec;
  }

  private locked<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repoPath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      repoPath,
      next.catch(() => undefined),
    );
    return next;
  }

  async prepare(repoId: string, supply: SupplyBody, task: TaskBody): Promise<Workspace> {
    const repo = this.repo(supply);
    const base = task.baseRef ?? repo.defaultBranch;
    return this.locked(repo.localPath, async () => {
      const tasksDir = join(this.config.workspacesDir, 'tasks');
      await mkdir(tasksDir, { recursive: true });
      const path = join(tasksDir, `task-${task.number}`);
      const branch = this.branchFor(task);
      if (!existsSync(path)) {
        await git(repo.localPath, ['worktree', 'add', '--quiet', '-b', branch, path, base]);
      } else if (task.baseRef) {
        // Picking the task up again: bring in what was integrated since (e.g. an upstream fix).
        await git(path, ['merge', '--quiet', '--no-edit', base]);
      }
      const baseCommit = await git(repo.localPath, ['rev-parse', base]);
      return { path, branch, repoSupplyId: repoId, baseCommit };
    });
  }

  /** Create an operation's integration branch from the default branch (idempotent). */
  async createBranch(supply: SupplyBody, name: string): Promise<string> {
    const repo = this.repo(supply);
    return this.locked(repo.localPath, async () => {
      const exists = (await git(repo.localPath, ['branch', '--list', name])).trim();
      if (!exists) await git(repo.localPath, ['branch', name, repo.defaultBranch]);
      return git(repo.localPath, ['rev-parse', name]);
    });
  }

  /** Merge a task's branch into the integration branch. Returns the new integration head. */
  async integrate(
    supply: SupplyBody,
    integrationBranch: string,
    taskBranch: string,
  ): Promise<string> {
    const repo = this.repo(supply);
    return this.locked(repo.localPath, async () => {
      const dir = join(
        this.config.workspacesDir,
        'integration',
        integrationBranch.replace(/[^a-z0-9-]/gi, '_'),
      );
      if (!existsSync(dir)) {
        await mkdir(join(this.config.workspacesDir, 'integration'), { recursive: true });
        await git(repo.localPath, ['worktree', 'add', '--quiet', dir, integrationBranch]);
      }
      await git(dir, [
        'merge',
        '--quiet',
        '--no-ff',
        '--no-edit',
        '-m',
        `Integrate ${taskBranch}`,
        taskBranch,
      ]);
      return git(dir, ['rev-parse', 'HEAD']);
    });
  }

  head(supply: SupplyBody, ref: string): Promise<string> {
    return git(this.repo(supply).localPath, ['rev-parse', ref]);
  }
}
