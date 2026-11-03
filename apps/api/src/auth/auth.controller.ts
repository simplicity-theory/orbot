import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { actorRef, type MeView, type Principal } from '@orbot/shared';
import { AuthorityService } from '../officers/authority.js';
import { OfficersService } from '../officers/officers.service.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CurrentPrincipal, Public } from './auth.guard.js';
import {
  COMMANDER,
  passphraseMatches,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signSession,
} from './session.js';

/** The Commander signs in with the passphrase alone; officers with their login and password. */
const LoginBody = z.object({
  login: z.string().trim().max(40).optional(),
  passphrase: z.string().min(1).max(500),
});

/** Failed sign-ins allowed from one address before it must wait. */
export const LOGIN_ATTEMPTS = 10;
/** How long an address waits after too many failures. */
export const LOGIN_LOCK_MS = 15 * 60_000;

/**
 * Slows down passphrase guessing: after LOGIN_ATTEMPTS failures from one address, sign-in from
 * it is refused for LOGIN_LOCK_MS. A success clears the count. Kept in memory (one API
 * process); addresses are never written to the record.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly attempts = LOGIN_ATTEMPTS,
    private readonly lockMs = LOGIN_LOCK_MS,
  ) {}

  /** Milliseconds the address must still wait, or 0. */
  lockedFor(ip: string, now = Date.now()): number {
    const f = this.failures.get(ip);
    if (!f) return 0;
    if (f.lockedUntil <= now) {
      if (f.lockedUntil) this.failures.delete(ip);
      return 0;
    }
    return f.lockedUntil - now;
  }

  failed(ip: string, now = Date.now()): void {
    const f = this.failures.get(ip) ?? { count: 0, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= this.attempts) {
      f.count = 0;
      f.lockedUntil = now + this.lockMs;
    }
    this.failures.set(ip, f);
    // Forgotten addresses: keep the map from growing without bound.
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.lockedUntil <= now) this.failures.delete(k);
    }
  }

  succeeded(ip: string): void {
    this.failures.delete(ip);
  }
}

@Controller('auth')
export class AuthController {
  private readonly throttle = new LoginThrottle();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly officers: OfficersService,
    private readonly authority: AuthorityService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? 'unknown';
    const wait = this.throttle.lockedFor(ip);
    if (wait > 0) {
      throw new HttpException(
        {
          message: 'Too many failed sign-ins from your address.',
          action: `Wait ${Math.ceil(wait / 60_000)} minute(s) and try again.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    let principal: Principal = COMMANDER;
    if (body.login) {
      const officer = await this.officers.authenticate(body.login, body.passphrase);
      if (!officer) {
        this.throttle.failed(ip);
        throw new UnauthorizedException({
          message: 'That login and password do not match an officer.',
          action: 'Check them and try again, or ask the Commander to reset your password.',
        });
      }
      principal = {
        kind: 'officer',
        id: officer.entityId,
        displayName: officer.body.name,
        rank: officer.body.rank,
      };
    } else if (!passphraseMatches(this.config.commanderPassphrase, body.passphrase)) {
      this.throttle.failed(ip);
      throw new UnauthorizedException({
        message: 'That passphrase is not correct.',
        action: 'Check ORBOT_COMMANDER_PASSPHRASE in your .env and try again.',
      });
    }
    this.throttle.succeeded(ip);
    res.cookie(SESSION_COOKIE, signSession(this.config.sessionSecret, principal), {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.cookieSecure,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    return { principal };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  async me(@CurrentPrincipal() p: Principal): Promise<MeView> {
    const s = await this.authority.standing(actorRef(p));
    return { principal: p, rank: s?.rank ?? 'commander', unitIds: s?.units ?? 'all' };
  }
}
