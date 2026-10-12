import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { SupplyBody, TaskBody, Workspace } from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { git } from '../common/git.js';

/**
 * Gives every task its own git worktree on its own branch, cut from the
 * connected repository's default branch. Worktrees are never removed.
 */
@Injectable()
export class WorkspaceManager {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  branchFor(task: Pick<TaskBody, 'number'>): string {
    return `orbot/task-${task.number}`;
  }

  async prepare(repoId: string, repo: SupplyBody, task: TaskBody): Promise<Workspace> {
    if (repo.spec.kind !== 'repository') throw new Error('Workspace needs a repository supply.');
    const tasksDir = join(this.config.workspacesDir, 'tasks');
    await mkdir(tasksDir, { recursive: true });
    const path = join(tasksDir, `task-${task.number}`);
    const branch = this.branchFor(task);
    if (!existsSync(path)) {
      await git(repo.spec.localPath, ['worktree', 'add', '--quiet', '-b', branch, path, repo.spec.defaultBranch]);
    }
    const baseCommit = await git(repo.spec.localPath, ['rev-parse', repo.spec.defaultBranch]);
    return { path, branch, repoSupplyId: repoId, baseCommit };
  }
}
