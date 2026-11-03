import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  ConnectEnvironmentRequest,
  ConnectRepositoryRequest,
  CreateRepositoryRequest,
  StoreCredentialRequest,
  type ProjectShape,
  type SupplyBody,
} from '@orbot/shared';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { git, GitError } from '../common/git.js';
import { RecordService, type WriteContext } from '../record/record.service.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { templateById } from './templates.js';

/** A folder name from a project name. */
export const folderName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '') || 'project';

const looksLikeUrl = (s: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[^@\s]+@[^:\s]+:/.test(s);

/**
 * The Supply Depot. Only what the Commander has connected exists.
 * Credentials are stored in the secrets store; the depot holds only their names.
 */
@Injectable()
export class SupplyService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly secrets: SecretsService,
    private readonly workspaces: WorkspaceManager,
  ) {}

  list() {
    return this.record.listActive('supply');
  }

  get(id: string) {
    return this.record.requireActive('supply', id);
  }

  /**
   * Connect a repository. ORBOT always works from its own clone (under the
   * workspaces directory) so bot branches never touch the original checkout.
   */
  async connectRepository(
    input: z.output<typeof ConnectRepositoryRequest>,
    ctx: WriteContext,
    project: ProjectShape | null = null,
  ) {
    const location = input.location;
    if (/:\/\/[^/@\s]+:[^/@\s]+@/.test(location)) {
      throw new BadRequestException({
        message: 'That URL contains a password or token.',
        action: 'Remove it from the URL and store it as a credential in the Supply Depot instead.',
      });
    }
    let source = location;
    if (!looksLikeUrl(location)) {
      source = isAbsolute(location) ? location : resolve(location);
      if (!existsSync(source)) {
        throw new BadRequestException({
          message: `No folder at ${source}.`,
          action: 'Check the path to the repository and try again.',
        });
      }
      try {
        await git(source, ['rev-parse', '--git-dir']);
      } catch {
        throw new BadRequestException({
          message: `${source} is not a git repository.`,
          action: 'Point at the root of a git repository (a folder containing .git).',
        });
      }
    }

    const id = randomUUID();
    const reposDir = join(this.config.workspacesDir, 'repos');
    await mkdir(reposDir, { recursive: true });
    const localPath = join(reposDir, id);
    try {
      await git(reposDir, ['clone', '--quiet', source, localPath]);
    } catch (err) {
      throw new BadRequestException({
        message: `Could not clone the repository: ${(err as GitError).message}`,
        action: 'Check the location is reachable from this machine.',
      });
    }
    const defaultBranch =
      input.defaultBranch ??
      (await git(localPath, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'main'));

    const body: SupplyBody = {
      name: input.name,
      connected: true,
      spec: { kind: 'repository', location, localPath, defaultBranch, project },
    };
    // An empty repository (no commits) gets its first commit, so work can start from it.
    const first = await this.workspaces.ensureDefaultBranch(body).catch((err: Error) => {
      throw new BadRequestException({
        message: `${input.name}: ${err.message}`,
        action: 'Give the repository a first commit on its default branch, then connect it again.',
      });
    });
    const created = await this.record.create('supply', body, ctx, id);
    if (first) {
      await this.record.event(
        'sitrep',
        {
          level: 'hq',
          text: `${input.name} was empty: ORBOT made its first commit (README.md) on ${defaultBranch}. It reaches the remote with the first push.`,
          status: null,
        },
        {},
        ctx.actor,
      );
    }
    return created;
  }

  /**
   * Start a repository from a template: ORBOT creates it under the workspaces' `source` folder,
   * makes the first commit, and connects it like any other. The template's shape (a single
   * HTML file) is kept on the depot item, so every bot is briefed with it.
   */
  async createRepository(input: z.output<typeof CreateRepositoryRequest>, ctx: WriteContext) {
    const name = input.name;
    const taken = (await this.list()).find(
      (s) => s.body.spec.kind === 'repository' && s.body.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) {
      throw new BadRequestException({
        message: `A repository called ${taken.body.name} is already in the Supply Depot.`,
        action: 'Choose another name, or use that repository.',
      });
    }
    const dir = join(this.config.workspacesDir, 'source', folderName(name));
    if (existsSync(dir)) {
      throw new BadRequestException({
        message: `A folder already exists at ${dir}.`,
        action: 'Choose another name, or connect that folder as a repository instead.',
      });
    }
    const template = templateById(input.template);
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--quiet', '--initial-branch=main']);
    for (const [file, content] of Object.entries(template.files(name))) {
      await writeFile(join(dir, file), content, 'utf8');
    }
    await git(dir, ['add', '--all']);
    await git(dir, ['commit', '--quiet', '--message', template.commit]);
    return this.connectRepository(
      { name, location: dir, defaultBranch: 'main' },
      { ...ctx, reason: ctx.reason || `Repository ${name} created (${template.label})` },
      template.project,
    );
  }

  /** Store a credential's value in the secrets store and list it in the depot by name. */
  async storeCredential(input: z.output<typeof StoreCredentialRequest>, ctx: WriteContext) {
    await this.secrets.store(input.name, input.value, ctx.actor);
    const existing = (await this.list()).find(
      (s) => s.body.spec.kind === 'credential' && s.body.spec.secretName === input.name,
    );
    if (existing) {
      return this.record.revise('supply', existing.entityId, (b) => ({ ...b, connected: true }), {
        ...ctx,
        reason: ctx.reason || `Credential ${input.name} rotated`,
      });
    }
    return this.record.create(
      'supply',
      { name: input.name, connected: true, spec: { kind: 'credential', secretName: input.name } },
      ctx,
    );
  }

  /** Connect an environment (e.g. staging, production). Deploy rights come from issuing it to a unit. */
  connectEnvironment(input: z.input<typeof ConnectEnvironmentRequest>, ctx: WriteContext) {
    const id = randomUUID();
    return this.record.create(
      'supply',
      {
        name: input.name,
        connected: true,
        spec: {
          kind: 'environment',
          details: { tier: input.tier },
          server: null,
          // A static site: ORBOT publishes into its own folder, one per site, and serves it.
          site: input.site
            ? {
                dir: join(this.config.workspacesDir, 'published', id),
                entry: 'index.html',
                last: null,
              }
            : null,
        },
      },
      ctx,
      id,
    );
  }

  revokeFromUnit(supplyId: string, unitId: string, ctx: WriteContext) {
    return this.record.revise(
      'unit',
      unitId,
      (u) => ({ ...u, supplyIds: u.supplyIds.filter((s) => s !== supplyId) }),
      ctx,
    );
  }

  async allotToUnit(supplyId: string, unitId: string, ctx: WriteContext) {
    await this.get(supplyId);
    return this.record.revise(
      'unit',
      unitId,
      (u) => (u.supplyIds.includes(supplyId) ? u : { ...u, supplyIds: [...u.supplyIds, supplyId] }),
      ctx,
    );
  }
}
