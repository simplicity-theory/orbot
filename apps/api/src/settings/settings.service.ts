import { Injectable } from '@nestjs/common';
import { DEFAULT_SETTINGS, SETTINGS_ID, type SettingsBody } from '@orbot/shared';
import { RecordService } from '../record/record.service.js';

/** Product settings as a versioned entity, so every change has who, when and why. */
@Injectable()
export class SettingsService {
  constructor(private readonly record: RecordService) {}

  async get(): Promise<SettingsBody & { version: number }> {
    const v = await this.record.getActive('settings', SETTINGS_ID);
    return v ? { ...v.body, version: v.version } : { ...DEFAULT_SETTINGS, version: 0 };
  }

  async update(
    patch: Partial<SettingsBody>,
    ctx: { actor: string; reason: string; expectedVersion?: number },
  ) {
    const current = await this.record.getActive('settings', SETTINGS_ID);
    if (!current)
      return this.record.create('settings', { ...DEFAULT_SETTINGS, ...patch }, ctx, SETTINGS_ID);
    return this.record.revise('settings', SETTINGS_ID, (s) => ({ ...s, ...patch }), ctx);
  }
}
