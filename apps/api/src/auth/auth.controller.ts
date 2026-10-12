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
import type { Principal } from '@orbot/shared';
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

const LoginBody = z.object({ passphrase: z.string().min(1).max(500) });

@Controller('auth')
export class AuthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!passphraseMatches(this.config.commanderPassphrase, body.passphrase)) {
      throw new UnauthorizedException({
        message: 'That passphrase is not correct.',
        action: 'Check ORBOT_COMMANDER_PASSPHRASE in your .env and try again.',
      });
    }
    res.cookie(SESSION_COOKIE, signSession(this.config.sessionSecret, COMMANDER), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env['NODE_ENV'] === 'production',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    return { principal: COMMANDER };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  me(@CurrentPrincipal() p: Principal) {
    return { principal: p };
  }
}
