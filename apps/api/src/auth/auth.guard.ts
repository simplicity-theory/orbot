import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { actorRef, type ActorRef, type Principal } from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { RecordService } from '../record/record.service.js';
import { SESSION_COOKIE, verifySession } from './session.js';

const IS_PUBLIC = 'orbot:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export type AuthedRequest = Request & { principal?: Principal };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]))
      return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const principal = verifySession(
      this.config.sessionSecret,
      (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE],
    );
    if (!principal) {
      throw new UnauthorizedException({
        message: 'You are not signed in.',
        action: 'Sign in to continue.',
      });
    }
    if (principal.kind === 'officer') {
      // Rank and retirement take effect at once, not when the session runs out.
      const o = await this.record.getActive('officer', principal.id);
      if (!o || o.body.retired) {
        throw new UnauthorizedException({
          message: 'Your appointment has ended.',
          action: 'Ask the Commander if you need access again.',
        });
      }
      req.principal = { ...principal, displayName: o.body.name, rank: o.body.rank };
      return true;
    }
    req.principal = {
      ...principal,
      rank: principal.kind === 'commander' ? 'commander' : undefined,
    };
    return true;
  }
}

/** The acting principal for this request. */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => {
    const p = ctx.switchToHttp().getRequest<AuthedRequest>().principal;
    if (!p) throw new UnauthorizedException('You are not signed in.');
    return p;
  },
);

/** The acting principal as an actor reference for the record. */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): ActorRef => {
  const p = ctx.switchToHttp().getRequest<AuthedRequest>().principal;
  if (!p) throw new UnauthorizedException('You are not signed in.');
  return actorRef(p);
});
