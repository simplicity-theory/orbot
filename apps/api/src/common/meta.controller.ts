import { Controller, Get, Inject } from '@nestjs/common';
import type { MetaView } from '@orbot/shared';
import { Public } from '../auth/auth.guard.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { RuntimeRegistry } from '../runtime/runtime.registry.js';

@Controller()
export class MetaController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly runtimes: RuntimeRegistry,
  ) {}

  @Public()
  @Get('meta')
  meta(): MetaView {
    return {
      productName: this.config.productName,
      runtime: this.config.defaultRuntime,
      runtimes: this.runtimes.kinds(),
      claudeModel: this.config.claudeModel,
    };
  }

  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }
}
