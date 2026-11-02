import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CommitDetailView,
  CommitOrigin,
  CommitSummary,
  RecordEvent,
  RecordVersion,
  RepositoryHistoryView,
  SupplyBody,
  TaskChangesView,
} from '@orbot/shared';
import { git } from '../common/git.js';
import { RecordService } from '../record/record.service.js';
import { addedFile, parseDiff } from './diff.js';

type RepoSpec = Extract<SupplyBody['spec'], { kind: 'repository' }>;

const SHA = /^[0-9a-f]{7,40}$/i;
/** Commit fields, unit-separated, record-separated. */
const FORMAT = '%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e';
const BIG = 64 * 1024 * 1024;
/** What ORBOT puts on record about a commit, by the body field that holds the sha. */
const ORIGIN_KINDS = [
  { kinds: ['artifact'], field: 'ref' },
  { kinds: ['integration', 'handoff', 'deployment'], field: 'commit' },
] as const;

/**
 * The code itself: commits and diffs in the depot's repositories, read straight from git and
 * tied back to the record (which task, bot and operation made each commit). Read-only: nothing
 * here writes to a repository. Responses pass the redaction layer like every other.
 */
@Injectable()
export class CodeService {
  constructor(private readonly record: RecordService) {}

  private async repository(id: string): Promise<RecordVersion<SupplyBody> & { spec: RepoSpec }> {
    const s = await this.record.getActive('supply', id);
    if (!s || s.body.spec.kind !== 'repository') {
      throw new NotFoundException({
        message: 'No repository with that id.',
        action: 'Open the repository from the Supply Depot.',
      });
    }
    if (!existsSync(s.body.spec.localPath)) {
      throw new NotFoundException({
        message: `${s.body.name} is not on this machine (${s.body.spec.localPath}).`,
        action: 'Reconnect it in the Supply Depot.',
      });
    }
    return Object.assign(s, { spec: s.body.spec });
  }

  private parse(out: string): Omit<CommitSummary, 'refs' | 'origin'>[] {
    return out
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha, parents, author, date, subject] = r.split('\x1f');
        return {
          sha: sha!,
          parents: parents ? parents.split(' ') : [],
          author: author ?? '',
          date: date ?? '',
          subject: subject ?? '',
        };
      });
  }

  /** Branch tips, by commit. */
  private async tips(path: string): Promise<Map<string, string[]>> {
    const out = await git(path, [
      'for-each-ref',
      '--format=%(objectname)%09%(refname:short)',
      'refs/heads',
    ]);
    const map = new Map<string, string[]>();
    for (const line of out.split('\n').filter(Boolean)) {
      const [sha, name] = line.split('\t');
      map.set(sha!, [...(map.get(sha!) ?? []), name!]);
    }
    return map;
  }

  /** Where each commit came from, from the record. */
  async origins(shas: string[]): Promise<Map<string, CommitOrigin>> {
    const out = new Map<string, CommitOrigin>();
    if (!shas.length) return out;
    const names = new Map<string, string | null>();
    const name = async (type: 'unit' | 'operation', id: string | null) => {
      if (!id) return null;
      const key = `${type}:${id}`;
      if (!names.has(key))
        names.set(key, (await this.record.getActive(type, id))?.body.name ?? null);
      return names.get(key)!;
    };
    for (const { kinds, field } of ORIGIN_KINDS) {
      const events = await this.record.eventsByBodyField([...kinds], field, shas);
      for (const e of events) {
        const b = e.body as Record<string, unknown>;
        if (e.kind === 'artifact' && b['kind'] !== 'commit') continue;
        const sha = String(b[field]);
        // A bot's own commit says more than HQ's note that it was handed off at it.
        if (out.get(sha)?.kind === 'commit') continue;
        out.set(sha, await this.originOf(e, name));
      }
    }
    return out;
  }

  private async originOf(
    e: RecordEvent,
    name: (type: 'unit' | 'operation', id: string | null) => Promise<string | null>,
  ): Promise<CommitOrigin> {
    const task = e.taskId ? await this.record.getActive('task', e.taskId) : null;
    const botId = e.botId ?? task?.body.botId ?? null;
    const bot = botId ? await this.record.getActive('bot', botId) : null;
    let operationId = e.operationId;
    if (!operationId && task?.body.missionId) {
      operationId =
        (await this.record.getActive('mission', task.body.missionId))?.body.operationId ?? null;
    }
    const unitId = e.unitId ?? task?.body.unitId ?? null;
    return {
      kind: e.kind === 'artifact' ? 'commit' : (e.kind as CommitOrigin['kind']),
      taskId: task?.entityId ?? null,
      taskNumber: task?.body.number ?? null,
      taskTitle: task?.body.title ?? null,
      unitId,
      unitName: await name('unit', unitId),
      botId: bot?.entityId ?? null,
      botCallsign: bot?.body.callsign ?? null,
      operationId,
      operationName: await name('operation', operationId),
    };
  }

  private async summaries(
    path: string,
    raw: Omit<CommitSummary, 'refs' | 'origin'>[],
  ): Promise<CommitSummary[]> {
    const [tips, origins] = await Promise.all([
      this.tips(path),
      this.origins(raw.map((c) => c.sha)),
    ]);
    return raw.map((c) => ({
      ...c,
      refs: tips.get(c.sha) ?? [],
      origin: origins.get(c.sha) ?? null,
    }));
  }

  /** A repository's history on one branch (the default one unless asked). */
  async history(repoId: string, ref: string | undefined): Promise<RepositoryHistoryView> {
    const repo = await this.repository(repoId);
    const branches = (
      await git(repo.spec.localPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    )
      .split('\n')
      .filter(Boolean);
    const kindOf = (b: string): RepositoryHistoryView['refs'][number]['kind'] =>
      b === repo.spec.defaultBranch
        ? 'default'
        : b.startsWith('orbot/op-')
          ? 'operation'
          : b.startsWith('orbot/task-')
            ? 'task'
            : 'other';
    const order = ['default', 'operation', 'task', 'other'];
    const refs = branches
      .map((name) => ({ name, kind: kindOf(name) }))
      .sort(
        (a, b) =>
          order.indexOf(a.kind) - order.indexOf(b.kind) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    const want = ref ?? repo.spec.defaultBranch;
    if (!branches.includes(want)) {
      throw new BadRequestException({
        message: `${repo.body.name} has no branch "${want}".`,
        action: 'Pick one of its branches.',
      });
    }
    const out = await git(repo.spec.localPath, [
      'log',
      `--format=${FORMAT}`,
      '-n',
      '200',
      want,
      '--',
    ]);
    return {
      repository: {
        id: repo.entityId,
        name: repo.body.name,
        defaultBranch: repo.spec.defaultBranch,
      },
      refs,
      ref: want,
      commits: await this.summaries(repo.spec.localPath, this.parse(out)),
    };
  }

  /** One commit: who made it, and what it changed (a merge: against its first parent). */
  async commit(repoId: string, sha: string): Promise<CommitDetailView> {
    if (!SHA.test(sha)) throw new BadRequestException('That is not a commit id.');
    const repo = await this.repository(repoId);
    const path = repo.spec.localPath;
    const full = await git(path, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).catch(
      () => '',
    );
    if (!full) {
      throw new NotFoundException({
        message: `${repo.body.name} has no commit ${sha.slice(0, 10)}.`,
        action: 'It may be in another repository.',
      });
    }
    const [meta] = this.parse(await git(path, ['show', '-s', `--format=${FORMAT}`, full]));
    const body = await git(path, ['show', '-s', '--format=%b', full]);
    const patch = meta!.parents.length
      ? await git(
          path,
          ['diff', '--no-color', '--no-ext-diff', '--find-renames', meta!.parents[0]!, full],
          {},
          { maxBuffer: BIG },
        )
      : await git(
          path,
          ['show', '--no-color', '--no-ext-diff', '--format=', '--root', full],
          {},
          { maxBuffer: BIG },
        );
    const { files, truncated } = parseDiff(patch);
    const [commit] = await this.summaries(path, [meta!]);
    return {
      repository: { id: repo.entityId, name: repo.body.name },
      commit: commit!,
      body,
      files,
      truncated,
    };
  }

  /** Find a commit in whichever connected repository has it. */
  async findCommit(sha: string): Promise<CommitDetailView> {
    if (!SHA.test(sha)) throw new BadRequestException('That is not a commit id.');
    const repos = (await this.record.listActive('supply')).filter(
      (s) => s.body.spec.kind === 'repository' && existsSync(s.body.spec.localPath),
    );
    for (const r of repos) {
      const spec = r.body.spec as RepoSpec;
      const found = await git(spec.localPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${sha}^{commit}`,
      ]).catch(() => '');
      if (found) return this.commit(r.entityId, sha);
    }
    throw new NotFoundException({
      message: `No repository in the depot has commit ${sha.slice(0, 10)}.`,
      action: 'It may have been made in a repository that is no longer connected.',
    });
  }

  /** Everything a task changed: its commits, the whole diff since its base, and what is not committed yet. */
  async taskChanges(taskId: string): Promise<TaskChangesView> {
    const task = await this.record.requireActive('task', taskId);
    const ws = task.body.workspace;
    const empty: TaskChangesView = {
      repository: null,
      branch: null,
      base: null,
      commits: [],
      files: [],
      uncommitted: [],
      truncated: false,
    };
    if (!ws) return empty;
    const repo = await this.repository(ws.repoSupplyId).catch(() => null);
    if (!repo) return empty;
    const path = repo.spec.localPath;
    const exists = await git(path, ['rev-parse', '--verify', '--quiet', ws.branch]).catch(() => '');
    const repository = { id: repo.entityId, name: repo.body.name };
    if (!exists) return { ...empty, repository, branch: ws.branch };
    const baseRef = task.body.baseRef ?? repo.spec.defaultBranch;
    const base = await git(path, ['merge-base', baseRef, ws.branch]).catch(() => ws.baseCommit);
    const log = await git(path, [
      'log',
      '--reverse',
      `--format=${FORMAT}`,
      `${base}..${ws.branch}`,
      '--',
    ]);
    const patch = await git(
      path,
      ['diff', '--no-color', '--no-ext-diff', '--find-renames', base, ws.branch],
      {},
      { maxBuffer: BIG },
    );
    const { files, truncated } = parseDiff(patch);
    const uncommitted = existsSync(ws.path) ? await this.uncommitted(ws.path) : [];
    return {
      repository,
      branch: ws.branch,
      base,
      commits: await this.summaries(path, this.parse(log)),
      files,
      uncommitted,
      truncated,
    };
  }

  /** The worktree's changes since its last commit, new files included. */
  private async uncommitted(path: string) {
    const patch = await git(
      path,
      ['diff', '--no-color', '--no-ext-diff', '--find-renames', 'HEAD'],
      {},
      { maxBuffer: BIG },
    ).catch(() => '');
    const { files } = parseDiff(patch);
    const untracked = (
      await git(path, ['ls-files', '--others', '--exclude-standard']).catch(() => '')
    )
      .split('\n')
      .filter(Boolean)
      .slice(0, 50);
    for (const p of untracked) {
      const content = await readFile(join(path, p), 'utf8').catch(() => '');
      files.push(addedFile(p, content));
    }
    return files;
  }
}
