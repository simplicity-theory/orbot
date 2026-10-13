import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
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

@Controller('auth')
export class AuthController {
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
    @Res({ passthrough: true }) res: Response,
  ) {
    let principal: Principal = COMMANDER;
    if (body.login) {
      const officer = await this.officers.authenticate(body.login, body.passphrase);
      if (!officer) {
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
      throw new UnauthorizedException({
        message: 'That passphrase is not correct.',
        action: 'Check ORBOT_COMMANDER_PASSPHRASE in your .env and try again.',
      });
    }
    res.cookie(SESSION_COOKIE, signSession(this.config.sessionSecret, principal), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env['NODE_ENV'] === 'production',
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
