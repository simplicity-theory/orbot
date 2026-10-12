import { ConflictException, Injectable } from '@nestjs/common';
import {
  actorRef,
  type BotBody,
  type BotRuntime,
  type RecordVersion,
  type UnitBody,
} from '@orbot/shared';
import { RecordService } from '../record/record.service.js';
import { RuntimeRegistry } from '../runtime/runtime.registry.js';

export interface UnitCommand {
  unit: RecordVersion<UnitBody>;
  overseer: RecordVersion<BotBody>;
  /** The Overseer's runtime: its "brain" for planning, curation and cold-start checks. */
  runtime: BotRuntime;
  /** Actor ref for record writes made by the Overseer. */
  actor: string;
}

/** Finds a unit's Overseer and the runtime it thinks with. */
/** HQ acts as a system actor, not a bot. */
export const HQ_ACTOR = 'system:hq';

@Injectable()
export class Overseers {
  constructor(
    private readonly record: RecordService,
    private readonly runtimes: RuntimeRegistry,
  ) {}

  async of(unitId: string): Promise<UnitCommand> {
    const unit = await this.record.requireActive('unit', unitId);
    if (!unit.body.overseerBotId) {
      throw new ConflictException({
        message: `${unit.body.name} has no Overseer.`,
        action: 'Assign an Overseer bot to the unit first.',
      });
    }
    const overseer = await this.record.requireActive('bot', unit.body.overseerBotId);
    return {
      unit,
      overseer,
      runtime: this.runtimes.get(overseer.body.runtime),
      actor: actorRef({ kind: 'bot', id: overseer.entityId }),
    };
  }
}
