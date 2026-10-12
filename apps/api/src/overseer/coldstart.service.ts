import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { RecordEvent, RecordVersion, TaskBody } from '@orbot/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Background } from '../common/background.js';
import { FieldManualService } from '../documents/field-manual.service.js';
import { RecordService } from '../record/record.service.js';
import { BriefingService } from './briefing.service.js';
import { Overseers } from './overseers.js';

/**
 * The cold-start check: the Overseer gives a notional fresh bot only the unit's
 * documents and asks whether it could continue the work. Gaps the Overseer can
 * close become Field Manual entries; the result is shown on the unit view.
 */
@Injectable()
export class ColdStartService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly briefing: BriefingService,
    private readonly fieldManual: FieldManualService,
    private readonly overseers: Overseers,
    private readonly background: Background,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.coldStartIntervalMs > 0) {
      this.timer = setInterval(() => void this.checkAll(), this.config.coldStartIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async checkAll() {
    for (const u of await this.record.listActive('unit')) {
      if (u.body.overseerBotId)
        this.background.run(`unit:${u.entityId}`, 'coldstart', () => this.check(u.entityId));
    }
  }

  async latest(unitId: string): Promise<RecordEvent<'coldstart.check'> | null> {
    const [e] = await this.record.listEvents(
      { unitId, kinds: ['coldstart.check'], limit: 1 },
      { latest: true },
    );
    return (e as RecordEvent<'coldstart.check'> | undefined) ?? null;
  }

  async check(unitId: string): Promise<RecordEvent<'coldstart.check'>> {
    const cmd = await this.overseers.of(unitId);
    const task = await this.pickTask(unitId);
    const k = await this.briefing.knowledge(unitId, task);
    const assessment = await cmd.runtime.assessColdStart({
      unit: { id: unitId, name: cmd.unit.body.name },
      task: task
        ? {
            id: task.entityId,
            number: task.body.number,
            title: task.body.title,
            status: task.body.status,
          }
        : null,
      ...k,
    });

    return this.record.transaction(async (w) => {
      const fixes: string[] = [];
      for (const gap of assessment.gaps) {
        if (!gap.suggestedEntry) continue;
        const e = await this.fieldManual.promote(
          w,
          unitId,
          { ...gap.suggestedEntry, tags: ['cold-start'], pinned: false },
          { kind: 'coldstart', id: null, version: null, label: 'Cold-start check' },
          { actor: cmd.actor, reason: `Cold-start gap: ${gap.description}` },
        );
        fixes.push(e.entityId);
      }
      if (fixes.length) {
        await this.fieldManual.rerender(w, unitId, {
          actor: cmd.actor,
          reason: 'Field Manual fixes from the cold-start check',
        });
      }
      return w.event(
        'coldstart.check',
        {
          taskId: task?.entityId ?? null,
          taskNumber: task?.body.number ?? null,
          score: assessment.score,
          gaps: assessment.gaps.map((g) => g.description),
          fixes,
        },
        { unitId, taskId: task?.entityId ?? null },
        cmd.actor,
      );
    });
  }

  /** The work a successor would most likely have to pick up: in-flight first, else the latest done. */
  private async pickTask(unitId: string): Promise<RecordVersion<TaskBody> | null> {
    const tasks = (await this.record.listActive('task', { unitId }))
      .filter((t) => t.body.status !== 'queued')
      .sort((a, b) => b.body.number - a.body.number);
    return tasks.find((t) => t.body.status !== 'done') ?? tasks[0] ?? null;
  }
}
