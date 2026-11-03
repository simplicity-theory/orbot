import { execFile, spawn } from 'node:child_process';
import { mkdir, readlink, realpath, rename, stat, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  actorRef,
  type PolicyRule,
  type Principal,
  type RecordEventRefs,
  type RecordVersion,
  type ServerResult,
  type SiteInfo,
  type StaticSite,
  type SupplyBody,
  type TaskBody,
} from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { git } from '../common/git.js';
import { PolicyService } from '../policy/policy.service.js';
import { RecordService } from '../record/record.service.js';
import { slug } from './servers.service.js';

export type Site = RecordVersion<SupplyBody> & {
  body: SupplyBody & { spec: { kind: 'environment'; site: StaticSite } };
};

const run = promisify(execFile);

/** A path inside the repository: no absolute paths, no `..`, nothing but the usual characters. */
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./ -]*$/;
const safePath = (p: string) =>
  SAFE_PATH.test(p) && !p.split('/').includes('..') && !p.split('/').includes('.');

/**
 * Static sites: environments with no server. A deploy publishes files from a task's committed
 * work into a folder on ORBOT's own machine, which ORBOT serves (sandboxed, so the published
 * page can reach nothing of ORBOT's) and offers for download. Every publication is kept in its
 * own folder; `current` only points at the latest (principle 4).
 */
@Injectable()
export class SitesService implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly policy: PolicyService,
  ) {}

  onModuleInit() {
    this.policy.addRule(this.productionRule());
  }

  /** As for servers: production is reached only inside a deploy the Commander approved. */
  private productionRule(): PolicyRule {
    return {
      name: 'Production sites',
      evaluate: async (req) => {
        if (req.action !== 'site.publish') return null;
        const task = req.taskId ? await this.record.getActive('task', req.taskId) : null;
        if (task?.body.kind === 'recon') {
          return {
            allowed: false,
            reason: 'Recon is read-only: a recon task publishes nothing',
            action: 'Give the unit a deploy task.',
          };
        }
        if (req.details?.['tier'] !== 'production') return null;
        if (task?.body.kind === 'deploy' && task.body.approval?.status === 'approved') return null;
        return {
          allowed: false,
          reason: `${String(req.details?.['site'])} is a production site: bots publish to it only inside a production deploy you approved`,
          action: 'Have the unit run it as a deploy task; it waits for your approval.',
        };
      },
    };
  }

  /** Where a site is served. */
  /** Where ORBOT serves the site: a path on ORBOT's own origin, so the link works wherever ORBOT is opened from (D131). */
  url(supplyId: string): string {
    return `/api/sites/${supplyId}/`;
  }

  static isSite(s: RecordVersion<SupplyBody> | null | undefined): s is Site {
    return !!s && s.body.connected && s.body.spec.kind === 'environment' && !!s.body.spec.site;
  }

  async get(supplyId: string): Promise<Site | null> {
    const s = await this.record.getActive('supply', supplyId);
    return SitesService.isSite(s) ? s : null;
  }

  async forUnit(unitId: string): Promise<Site[]> {
    const unit = await this.record.requireActive('unit', unitId);
    const out: Site[] = [];
    for (const id of unit.body.supplyIds) {
      const s = await this.record.getActive('supply', id);
      if (SitesService.isSite(s)) out.push(s);
    }
    return out;
  }

  async list(unitId: string): Promise<SiteInfo[]> {
    return (await this.forUnit(unitId)).map((s) => ({
      name: s.body.name,
      tier: s.body.spec.details['tier'] ?? 'staging',
      url: this.url(s.entityId),
      entry: s.body.spec.site.entry,
      lastCommit: s.body.spec.site.last?.commit ?? null,
    }));
  }

  /**
   * Publish `paths` (files or folders, relative to the repository; none = the project's entry
   * file, or everything tracked) from HEAD of the task's branch to the named site.
   */
  async publish(
    task: RecordVersion<TaskBody>,
    bot: Principal,
    refs: RecordEventRefs,
    name: string,
    paths: string[],
  ): Promise<ServerResult> {
    if (!task.body.workspace) throw new Error('This task has no workspace to publish from.');
    const sites = await this.forUnit(task.body.unitId);
    const site = sites.find((x) => x.body.name.toLowerCase() === name.trim().toLowerCase());
    if (!site) {
      throw new Error(
        `Your unit holds no site called "${name}". ${sites.length ? `It holds: ${sites.map((x) => x.body.name).join(', ')}.` : 'It holds none: ask for one with blocked.'}`,
      );
    }
    const bad = paths.find((p) => !safePath(p));
    if (bad) throw new Error(`"${bad}" is not a path inside the repository.`);
    const tier = site.body.spec.details['tier'] ?? 'staging';
    const d = await this.policy.check({
      principal: bot,
      action: 'site.publish',
      unitId: task.body.unitId,
      taskId: task.entityId,
      details: { site: site.body.name, supplyId: site.entityId, tier, paths },
    });
    if (!d.allowed) throw new Error(`Refused: ${d.reason}. ${d.action ?? ''}`.trim());

    const ws = task.body.workspace.path;
    const commit = await git(ws, ['rev-parse', 'HEAD']);
    let wanted = paths;
    if (!wanted.length) {
      const repo = task.body.repoSupplyId
        ? await this.record.getActive('supply', task.body.repoSupplyId)
        : null;
      const entry = repo?.body.spec.kind === 'repository' ? repo.body.spec.project?.entry : null;
      wanted = entry ? [entry] : [];
    }
    const files = (await git(ws, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...wanted]))
      .split('\n')
      .filter(Boolean);
    if (!files.length) {
      throw new Error(
        `Nothing to publish: ${wanted.length ? wanted.join(', ') : 'the repository'} has no committed file at HEAD. Commit first.`,
      );
    }
    const entry = site.body.spec.site.entry;
    if (!files.includes(entry)) {
      throw new Error(
        `The site serves ${entry} at its root, and it is not among the files published (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}). Publish it too.`,
      );
    }

    // Each publication in its own folder; `current` is moved to it in one step.
    const dir = site.body.spec.site.dir;
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${commit.slice(0, 10)}`;
    const target = join(dir, 'versions', stamp);
    await mkdir(target, { recursive: true });
    await this.extract(ws, commit, wanted, target);
    const tmp = join(dir, `.current-${stamp}`);
    await symlink(join('versions', stamp), tmp);
    await rename(tmp, join(dir, 'current'));
    await git(ws, ['branch', '--force', `deploy/${slug(site.body.name)}`, commit]).catch(() => {});

    const url = this.url(site.entityId);
    const at = new Date().toISOString();
    await this.record.transaction(async (w) => {
      await w.revise(
        'supply',
        site.entityId,
        (b) => ({
          ...b,
          spec:
            b.spec.kind === 'environment' && b.spec.site
              ? { ...b.spec, site: { ...b.spec.site, last: { commit, at, taskId: task.entityId } } }
              : b.spec,
        }),
        { actor: actorRef(bot), reason: `Published ${commit.slice(0, 10)}` },
      );
      await w.event(
        'deployment',
        { environment: site.body.name, ref: `deploy/${slug(site.body.name)}`, commit, url },
        refs,
        actorRef(bot),
      );
    });
    return {
      exitCode: 0,
      output: `Published ${files.length} file(s) at ${commit.slice(0, 10)} to ${site.body.name}: ${url}`,
    };
  }

  /**
   * Publish a repository's `ref` (its entry file) to a site: HQ's doing at the end of an
   * automatic theatre's operation, so no task and no policy check (the theatre's setting is
   * the Commander's order) (D122).
   */
  async publishRef(
    site: Site,
    repo: SupplyBody,
    ref: string,
    refs: RecordEventRefs,
    actor: string,
  ): Promise<{ commit: string; url: string }> {
    if (repo.spec.kind !== 'repository') throw new Error('Not a repository.');
    const ws = repo.spec.localPath;
    const commit = await git(ws, ['rev-parse', ref]);
    const entry = site.body.spec.site.entry;
    const files = (await git(ws, ['ls-tree', '-r', '--name-only', commit, '--', entry]))
      .split('\n')
      .filter(Boolean);
    if (!files.includes(entry)) {
      throw new Error(
        `${repo.name} has no ${entry} at ${commit.slice(0, 10)}: nothing to publish.`,
      );
    }
    const dir = site.body.spec.site.dir;
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${commit.slice(0, 10)}`;
    const target = join(dir, 'versions', stamp);
    await mkdir(target, { recursive: true });
    await this.extract(ws, commit, [entry], target);
    const tmp = join(dir, `.current-${stamp}`);
    await symlink(join('versions', stamp), tmp);
    await rename(tmp, join(dir, 'current'));
    const url = this.url(site.entityId);
    const at = new Date().toISOString();
    await this.record.transaction(async (w) => {
      await w.revise(
        'supply',
        site.entityId,
        (b) => ({
          ...b,
          spec:
            b.spec.kind === 'environment' && b.spec.site
              ? { ...b.spec, site: { ...b.spec.site, last: { commit, at, taskId: null } } }
              : b.spec,
        }),
        { actor, reason: `Published ${commit.slice(0, 10)}` },
      );
      await w.event(
        'deployment',
        { environment: site.body.name, ref: `deploy/${slug(site.body.name)}`, commit, url },
        refs,
        actor,
      );
    });
    return { commit, url };
  }

  /** `git archive` of the wanted paths at `commit`, unpacked into `target`. */
  private async extract(ws: string, commit: string, paths: string[], target: string) {
    const { stdout: archive } = await run(
      'git',
      ['archive', '--format=tar', commit, '--', ...paths],
      { cwd: ws, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
    );
    await new Promise<void>((resolveDone, reject) => {
      const tar = spawn('tar', ['-xf', '-', '-C', target], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      tar.stderr.on('data', (c: Buffer) => (err += c.toString()));
      tar.on('error', reject);
      tar.on('close', (code) =>
        code === 0 ? resolveDone() : reject(new Error(`tar failed: ${err.trim()}`)),
      );
      tar.stdin.end(archive);
    });
  }

  /**
   * The published file at `path` (empty = the entry), as an absolute path inside the current
   * publication, or null when the site has nothing published or the path is not in it.
   */
  async published(site: Site, path: string): Promise<{ file: string; name: string } | null> {
    const dir = site.body.spec.site.dir;
    const rel = path.replace(/^\/+/, '') || site.body.spec.site.entry;
    if (!safePath(rel)) return null;
    let root: string;
    try {
      await readlink(join(dir, 'current'));
      root = await realpath(join(dir, 'current'));
    } catch {
      return null;
    }
    const inside = resolve(root, rel);
    const r = relative(root, inside);
    if (r.startsWith('..') || resolve(dirname(root), '') !== resolve(dir, 'versions')) return null;
    if (!inside.startsWith(root + sep) && inside !== root) return null;
    try {
      const st = await stat(inside);
      if (st.isDirectory()) {
        const index = join(inside, 'index.html');
        return (await stat(index).catch(() => null))?.isFile()
          ? { file: index, name: 'index.html' }
          : null;
      }
      return st.isFile() ? { file: inside, name: rel.split('/').pop()! } : null;
    } catch {
      return null;
    }
  }
}
