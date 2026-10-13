import { OFFICER_SECRET_PREFIX } from '../officers/officers.service.js';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ConnectRepositoryRequest, StoreCredentialRequest } from '@orbot/shared';
import { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { toView, toViews } from '../domain/view.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { SupplyService } from './supply.service.js';

const ConnectEnvironment = z.object({
  name: z.string().trim().min(1).max(100),
  tier: z.enum(['staging', 'production']),
});
const Allotment = z.object({
  supplyId: z.uuid(),
  unitId: z.uuid(),
  revoke: z.boolean().default(false),
});

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

  @Post('environments')
  async connectEnvironment(
    @Body(new ZodPipe(ConnectEnvironment)) body: z.output<typeof ConnectEnvironment>,
    @Actor() actor: string,
  ) {
    return toView(
      await this.supply.connectEnvironment(body, {
        actor,
        reason: `Environment ${body.name} connected`,
      }),
    );
  }

  @Post('allot')
  @HttpCode(200)
  async allot(
    @Body(new ZodPipe(Allotment)) body: z.output<typeof Allotment>,
    @Actor() actor: string,
  ) {
    const ctx = {
      actor,
      reason: body.revoke ? 'Supply withdrawn from the unit' : 'Supply issued to the unit',
    };
    return toView(
      body.revoke
        ? await this.supply.revokeFromUnit(body.supplyId, body.unitId, ctx)
        : await this.supply.allotToUnit(body.supplyId, body.unitId, ctx),
    );
  }

  /** Names and dates only. */
  @Get('secrets')
  async listSecrets() {
    // Officers' password hashes live in the secrets store too; they are not supply.
    return (await this.secrets.list()).filter((s) => !s.name.startsWith(OFFICER_SECRET_PREFIX));
  }
}
