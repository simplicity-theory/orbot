import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  CreateTaskRequest,
  type PolicyRule,
  type RecordVersion,
  type TaskBody,
} from '@orbot/shared';
import { WorkService } from '../domain/work.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { RecordService } from '../record/record.service.js';

/**
 * Recon: a read-only survey. A bot studies the code to answer a question and files a
 * report, which becomes one of its unit's documents (briefed to later work that it bears
 * on). A policy rule keeps recon read-only: a recon task that tries to change anything is
 * held. HQ can send a unit to recon before planning an operation.
 */
@Injectable()
export class ReconService implements OnModuleInit {
  constructor(
    private readonly record: RecordService,
    private readonly work: WorkService,
    private readonly policy: PolicyService,
  ) {}

  onModuleInit() {
    this.policy.addRule(this.rule());
  }

  private rule(): PolicyRule {
    return {
      name: 'Recon is read-only',
      evaluate: async (req) => {
        if (req.principal.kind !== 'bot' || req.action !== 'bot.artifact' || !req.taskId)
          return null;
        const task = await this.record.getActive('task', req.taskId);
        if (task?.body.kind !== 'recon') return null;
        return {
          allowed: false,
          reason: 'Recon is read-only: a recon task may not change the code',
          action: 'Give the unit a task (or a mission) to make the change.',
        };
      },
    };
  }

  /** Order a recon. The unit's least busy free bot takes it; its Overseer starts it. */
  async order(
    input: { unitId: string; question: string; repoSupplyId: string | null },
    actor: string,
    reason = 'Recon ordered',
  ): Promise<RecordVersion<TaskBody>> {
    const unit = await this.record.requireActive('unit', input.unitId);
    const repoSupplyId = input.repoSupplyId ?? (await this.firstRepository(unit.body.supplyIds));
    if (!repoSupplyId) {
      throw new BadRequestException({
        message: `${unit.body.name} has no repository to survey.`,
        action: 'Allot one to the unit from the Supply Depot, then order the recon again.',
      });
    }
    const bots = (await this.record.listActive('bot', { unitId: unit.entityId })).filter(
      (b) => !b.body.isOverseer && b.body.status !== 'stood-down' && !b.body.halt,
    );
    const free = (b: (typeof bots)[number]) =>
      b.body.status === 'idle' ? 0 : b.body.status === 'working' ? 1 : 2;
    const bot = bots.sort(
      (a, b) =>
        free(a) - free(b) ||
        a.body.queue.length - b.body.queue.length ||
        a.body.callsign.localeCompare(b.body.callsign, undefined, { numeric: true }),
    )[0];
    if (!bot) {
      throw new BadRequestException({
        message: `${unit.body.name} has no bot free to send on recon.`,
        action: 'Add a bot to the unit, or resume one that is stood down.',
      });
    }
    const question = input.question.trim();
    const title = `Recon: ${question.length > 120 ? `${question.slice(0, 117)}…` : question}`;
    const number = await this.record.nextTaskNumber();
    return this.record.transaction((w) =>
      this.work.writeTask(
        w,
        number,
        {
          ...CreateTaskRequest.parse({
            unitId: unit.entityId,
            botId: bot.entityId,
            title,
            description: question,
            repoSupplyId,
            scenario: 'recon',
          }),
          kind: 'recon',
          autoStart: true,
        },
        { actor, reason },
      ),
    );
  }

  /** The recon report filed for a task, if any. */
  async reportFor(taskId: string) {
    const [doc] = await this.record.listActive('document', {
      bodyContains: { kind: 'recon', taskId },
    });
    return doc ?? null;
  }

  private async firstRepository(ids: string[]) {
    for (const id of ids) {
      const s = await this.record.getActive('supply', id);
      if (s?.body.connected && s.body.spec.kind === 'repository') return s.entityId;
    }
    return null;
  }
}
