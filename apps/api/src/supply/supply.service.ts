import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConnectRepositoryRequest, StoreCredentialRequest, type SupplyBody } from '@orbot/shared';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { git, GitError } from '../common/git.js';
import { RecordService, type WriteContext } from '../record/record.service.js';
import { SecretsService } from '../secrets/secrets.service.js';

const looksLikeUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[^@\s]+@[^:\s]+:/.test(s);

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
  async connectRepository(input: z.output<typeof ConnectRepositoryRequest>, ctx: WriteContext) {
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
      input.defaultBranch ?? (await git(localPath, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'main'));

    const body: SupplyBody = {
      name: input.name,
      connected: true,
      spec: { kind: 'repository', location, localPath, defaultBranch },
    };
    return this.record.create('supply', body, ctx, id);
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
