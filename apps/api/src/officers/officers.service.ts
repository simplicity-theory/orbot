import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type {
  AppointOfficerRequest,
  OfficerBody,
  RecordVersion,
  UpdateOfficerRequest,
} from '@orbot/shared';
import type { z } from 'zod';
import { RecordService } from '../record/record.service.js';
import { SecretsService } from '../secrets/secrets.service.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** Secrets-store names for officers' password hashes. Never shown in the Supply Depot. */
export const OFFICER_SECRET_PREFIX = 'officer-login.';
const secretName = (officerId: string) => `${OFFICER_SECRET_PREFIX}${officerId}`;

async function hash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verify(password: string, stored: string): Promise<boolean> {
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const given = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(given, expected);
}

/**
 * Other officers. Each is a versioned `officer` entity (name, login, rank, units); the
 * password is hashed with scrypt and kept in the secrets store, so it is on no record and
 * in no response. Officers are retired, never deleted.
 */
@Injectable()
export class OfficersService {
  constructor(
    private readonly record: RecordService,
    private readonly secrets: SecretsService,
  ) {}

  list() {
    return this.record.listActive('officer');
  }

  get(id: string) {
    return this.record.getActive('officer', id);
  }

  async appoint(input: z.output<typeof AppointOfficerRequest>, actor: string) {
    if ((await this.list()).some((o) => o.body.login === input.login)) {
      throw new ConflictException({
        message: `The login “${input.login}” is taken.`,
        action: 'Choose another login.',
      });
    }
    await this.checkUnits(input.rank, input.unitIds);
    const officer = await this.record.create(
      'officer',
      {
        name: input.name,
        login: input.login,
        rank: input.rank,
        unitIds: input.rank === 'captain' ? input.unitIds : [],
        retired: false,
      },
      { actor, reason: `Appointed ${input.rank}` },
    );
    await this.secrets.store(secretName(officer.entityId), await hash(input.password), actor);
    return officer;
  }

  async update(id: string, input: z.output<typeof UpdateOfficerRequest>, actor: string) {
    const current = await this.record.requireActive('officer', id);
    const rank = input.rank ?? current.body.rank;
    const unitIds = input.unitIds ?? current.body.unitIds;
    await this.checkUnits(rank, unitIds);
    return this.record.revise(
      'officer',
      id,
      (o) => ({
        ...o,
        rank,
        unitIds: rank === 'captain' ? unitIds : [],
        retired: input.retired ?? o.retired,
      }),
      { actor, reason: input.reason },
    );
  }

  async resetPassword(id: string, password: string, actor: string) {
    await this.record.requireActive('officer', id);
    await this.secrets.store(secretName(id), await hash(password), actor);
  }

  /** Sign-in check. Null for an unknown login, a wrong password or a retired officer. */
  async authenticate(login: string, password: string): Promise<RecordVersion<OfficerBody> | null> {
    const officer = (await this.list()).find((o) => o.body.login === login.trim().toLowerCase());
    if (!officer || officer.body.retired) {
      // Same work either way, so timing doesn't say whether the login exists.
      await hash(password);
      return null;
    }
    const stored = await this.secrets.reveal(secretName(officer.entityId)).catch(() => null);
    if (!stored || !(await verify(password, stored))) return null;
    return officer;
  }

  private async checkUnits(rank: string, unitIds: string[]) {
    if (rank !== 'captain') return;
    if (!unitIds.length) {
      throw new BadRequestException({
        message: 'A Captain commands at least one unit.',
        action: 'Choose the units they command.',
      });
    }
    for (const id of unitIds) await this.record.requireActive('unit', id);
  }
}
