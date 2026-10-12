import { Injectable } from '@nestjs/common';
import type { EntityInputMap } from '@orbot/shared';
import { RecordService, type WriteContext } from '../record/record.service.js';

/** Units and bots: the order of battle. */
@Injectable()
export class ForceService {
  constructor(private readonly record: RecordService) {}

  async listUnits() {
    const units = await this.record.listActive('unit');
    return units.sort((a, b) => a.body.order - b.body.order);
  }

  getUnit(id: string) {
    return this.record.requireActive('unit', id);
  }

  createUnit(body: EntityInputMap['unit'], ctx: WriteContext, id?: string) {
    return this.record.create('unit', body, ctx, id);
  }

  listBots(unitId?: string) {
    return this.record.listActive('bot', unitId ? { unitId } : {});
  }

  getBot(id: string) {
    return this.record.requireActive('bot', id);
  }

  createBot(body: EntityInputMap['bot'], ctx: WriteContext, id?: string) {
    return this.record.create('bot', body, ctx, id);
  }

  async nextCallsign(unitId: string): Promise<string> {
    const unit = await this.getUnit(unitId);
    const bots = await this.listBots(unitId);
    const used = new Set(bots.map((b) => b.body.callsign));
    let n = 1;
    while (used.has(`${unit.body.callsignPrefix}-${n}`)) n++;
    return `${unit.body.callsignPrefix}-${n}`;
  }
}
