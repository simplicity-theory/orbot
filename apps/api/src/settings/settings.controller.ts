import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import {
  AlertSettings,
  CHAT_ACTION_KINDS,
  DailyBriefSettings,
  EscalationSettings,
} from '@orbot/shared';
import { validTimeZone } from '../overseer/daily-brief.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
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
  dailyBrief: DailyBriefSettings.refine((d) => validTimeZone(d.timeZone), {
    message: 'Not a time zone: use an IANA name such as Europe/London.',
    path: ['timeZone'],
  }).optional(),
  alerts: AlertSettings.optional(),
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().nonnegative(),
});

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
  ) {}

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
    const name = patch.alerts?.credentialName;
    if (name && !(await this.secrets.list()).some((s) => s.name === name && !s.revoked)) {
      throw new BadRequestException({
        message: `No credential named “${name}” is stored.`,
        action: 'Store the push URL in the Supply Depot first, then choose it here.',
      });
    }
    await this.settings.update(patch, {
      actor,
      reason,
      ...(expectedVersion ? { expectedVersion } : {}),
    });
    return { ...(await this.settings.get()), actionKinds: CHAT_ACTION_KINDS };
  }
}
