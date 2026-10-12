import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConnectRepositoryRequest, StoreCredentialRequest } from '@orbot/shared';
import type { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView, toViews } from '../domain/view.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { SupplyService } from './supply.service.js';

@Controller('supply')
export class SupplyController {
  constructor(
    private readonly supply: SupplyService,
    private readonly secrets: SecretsService,
  ) {}

  @Get()
  async list() {
    return toViews(await this.supply.list());
  }

  @Post('repositories')
  async connectRepository(
    @Body(new ZodPipe(ConnectRepositoryRequest)) body: z.output<typeof ConnectRepositoryRequest>,
    @Actor() actor: string,
  ) {
    return toView(
      await this.supply.connectRepository(body, {
        actor,
        reason: `Repository ${body.name} connected`,
      }),
    );
  }

  /** Write-only: the value goes to the secrets store and is never returned. */
  @Post('credentials')
  async storeCredential(
    @Body(new ZodPipe(StoreCredentialRequest)) body: z.output<typeof StoreCredentialRequest>,
    @Actor() actor: string,
  ) {
    return toView(
      await this.supply.storeCredential(body, { actor, reason: `Credential ${body.name} stored` }),
    );
  }

  /** Names and dates only. */
  @Get('secrets')
  listSecrets() {
    return this.secrets.list();
  }
}
