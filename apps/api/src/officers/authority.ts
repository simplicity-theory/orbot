import {
  ForbiddenException,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RANK_LABEL, type Rank } from '@orbot/shared';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { RecordService } from '../record/record.service.js';

/** Finds the units a request acts on; null means it isn't about particular units (Commander's business). */
export type UnitResolver = (req: AuthedRequest, record: RecordService) => Promise<string[] | null>;

/**
 * Who may make a write:
 * - `read`: anyone signed in (the handler checks anything finer, e.g. chat orders);
 * - `officer`: Captains and the Commander;
 * - `unit`: the Commander, or a Captain who commands every unit the request acts on.
 * Writes without this metadata are the Commander's alone: fail closed.
 */
export interface AuthorityRule {
  level: 'read' | 'officer' | 'unit';
  units?: UnitResolver;
}
const AUTHORITY = 'orbot:authority';
export const Authority = (rule: AuthorityRule) => SetMetadata(AUTHORITY, rule);

type Owned = 'unit' | 'task' | 'bot' | 'backbrief' | 'mission' | 'fm-entry' | 'document';

/** The unit that owns an entity named in the route or body. */
export function unitOf(
  entity: Owned,
  from: 'param' | 'body',
  key = from === 'param' ? 'id' : 'unitId',
): UnitResolver {
  return async (req, record) => {
    const raw = from === 'param' ? req.params[key] : (req.body as Record<string, unknown>)?.[key];
    if (typeof raw !== 'string') return null;
    if (entity === 'unit') return [raw];
    const v = await record.getActive(entity, raw);
    const unitId = (v?.body as { unitId?: string | null } | undefined)?.unitId;
    return unitId ? [unitId] : null;
  };
}

/** A stand-down order on a unit or a bot acts on that unit; on everything, on no unit in particular. */
export const standDownUnits: UnitResolver = async (req, record) => {
  const b = req.body as { scope?: string; targetId?: string | null } | undefined;
  if (!b?.targetId || b.scope === 'all') return null;
  return b.scope === 'bot' ? unitOf('bot', 'body', 'targetId')(req, record) : [b.targetId];
};

/** An escalation chain acts on the unit whose work got stuck. */
export const escalationUnits: UnitResolver = async (req, record) => {
  const chainId = req.params['chainId'];
  const events = await record.listEvents({ kinds: ['escalation'], limit: 1000 }, { latest: true });
  const e = events.find((x) => (x.body as { chainId?: string }).chainId === chainId);
  return e?.unitId ? [e.unitId] : null;
};

/** The person's rank, and the units they command. */
export interface Standing {
  rank: Rank;
  name: string;
  units: string[] | 'all';
}

@Injectable()
export class AuthorityService {
  constructor(private readonly record: RecordService) {}

  /** Null for bots and system actors (they are limited by the policy layer, not by rank). */
  async standing(actor: string): Promise<Standing | null> {
    if (actor.startsWith('commander:'))
      return { rank: 'commander', name: 'Commander', units: 'all' };
    if (!actor.startsWith('officer:')) return null;
    const o = await this.record.getActive('officer', actor.slice('officer:'.length));
    if (!o || o.body.retired)
      return { rank: 'observer', name: o?.body.name ?? 'Former officer', units: [] };
    return {
      rank: o.body.rank,
      name: o.body.name,
      units: o.body.rank === 'commander' ? 'all' : o.body.rank === 'captain' ? o.body.unitIds : [],
    };
  }

  /**
   * May this actor order this? `unitIds` null means it isn't about particular units, which
   * only a Commander may order. Returns why not, or null if they may.
   */
  async refusal(
    actor: string,
    unitIds: string[] | null,
    officerLevel = false,
  ): Promise<string | null> {
    const s = await this.standing(actor);
    if (!s || s.units === 'all') return null;
    const who = `${RANK_LABEL[s.rank]} ${s.name}`;
    if (s.rank === 'observer')
      return `${who} is an Observer: Observers read, they don't give orders.`;
    if (officerLevel) return null;
    if (!unitIds) return `Only a Commander can order that; ${who} commands particular units.`;
    const names: string[] = [];
    for (const id of unitIds.filter((u) => !(s.units as string[]).includes(u))) {
      names.push((await this.record.getActive('unit', id))?.body.name ?? 'that unit');
    }
    return names.length ? `${who} does not command ${names.join(' or ')}.` : null;
  }

  async require(actor: string, unitIds: string[] | null, officerLevel = false): Promise<void> {
    const why = await this.refusal(actor, unitIds, officerLevel);
    if (why) {
      throw new ForbiddenException({
        message: why,
        action: 'Ask the Commander, or an officer who commands that unit.',
      });
    }
  }
}

/** Every write passes here: the Commander may do anything; officers only what their rank allows. */
@Injectable()
export class AuthorityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authority: AuthorityService,
    private readonly record: RecordService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const p = req.principal;
    if (!p || p.kind !== 'officer') return true; // public routes, and the Commander
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    const rule = this.reflector.getAllAndOverride<AuthorityRule | undefined>(AUTHORITY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const actor = `officer:${p.id}`;
    if (!rule) {
      await this.authority.require(actor, null);
    } else if (rule.level === 'read') {
      return true;
    } else if (rule.level === 'officer') {
      await this.authority.require(actor, null, true);
    } else {
      await this.authority.require(actor, rule.units ? await rule.units(req, this.record) : null);
    }
    return true;
  }
}
