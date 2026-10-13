import { Body, Controller, Get, Put } from '@nestjs/common';
import { CHAT_ACTION_KINDS, EscalationSettings } from '@orbot/shared';
import { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { SettingsService } from './settings.service.js';

const UpdateSettings = z.object({
  irreversibleActions: z.array(z.enum(CHAT_ACTION_KINDS as [string, ...string[]])).optional(),
  confirmationPhrase: z.string().trim().min(1).max(50).optional(),
  budgetWarnAt: z.number().min(0.1).max(1).optional(),
  escalation: EscalationSettings.optional(),
  mainEffortYield: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().nonnegative(),
});

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async get() {
    return { ...(await this.settings.get()), actionKinds: CHAT_ACTION_KINDS };
  }

  @Put()
  async update(
    @Body(new ZodPipe(UpdateSettings)) body: z.infer<typeof UpdateSettings>,
    @Actor() actor: string,
  ) {
    const { reason, expectedVersion, ...patch } = body;
    await this.settings.update(patch, {
      actor,
      reason,
      ...(expectedVersion ? { expectedVersion } : {}),
    });
    return { ...(await this.settings.get()), actionKinds: CHAT_ACTION_KINDS };
  }
}
