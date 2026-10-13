import { Controller, Get, Post } from '@nestjs/common';
import { Actor } from '../auth/auth.guard.js';
import { AlertService } from './alert.service.js';
import { DailyBriefService } from './daily-brief.service.js';

/** HQ's daily brief, and phone alerts. */
@Controller()
export class DailyBriefController {
  constructor(
    private readonly briefs: DailyBriefService,
    private readonly alerts: AlertService,
  ) {}

  @Get('daily-brief')
  view() {
    return this.briefs.view();
  }

  /** Write today's brief now (a new version if it is already written). */
  @Post('daily-brief')
  async write(@Actor() actor: string) {
    await this.briefs.write(actor);
    return this.briefs.view();
  }

  /** The latest alerts sent (names and outcomes; never the push URL). */
  @Get('alerts')
  recent() {
    return this.alerts.recent();
  }

  @Post('alerts/test')
  test(@Actor() actor: string) {
    return this.alerts.test(actor);
  }
}
