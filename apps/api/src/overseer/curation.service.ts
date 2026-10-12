import { Injectable } from '@nestjs/common';
import type { SourceRef } from '@orbot/shared';
import { FieldManualService } from '../documents/field-manual.service.js';
import { RecordService } from '../record/record.service.js';
import { Overseers } from './overseers.js';

/**
 * The Overseer curates the unit's Field Manual: after every handover it promotes
 * lasting lessons (with provenance), merges duplicates and retires what is outdated.
 */
@Injectable()
export class CurationService {
  constructor(
    private readonly record: RecordService,
    private readonly fieldManual: FieldManualService,
    private readonly overseers: Overseers,
  ) {}

  async curateHandover(documentId: string): Promise<void> {
    const doc = await this.record.getActive('document', documentId);
    if (!doc || doc.body.kind !== 'handover' || !doc.body.unitId) return;
    const unitId = doc.body.unitId;
    const unit = await this.record.getActive('unit', unitId);
    if (!unit?.body.overseerBotId) return; // No Overseer, no curation.
    const cmd = await this.overseers.of(unitId);
    const task = doc.body.taskId ? await this.record.getActive('task', doc.body.taskId) : null;
    const entries = await this.fieldManual.entries(unitId);
    const actions = await cmd.runtime.curate({
      unit: { id: unitId, name: cmd.unit.body.name },
      handover: {
        documentId,
        version: doc.version,
        taskNumber: task?.body.number ?? null,
        markdown: doc.body.markdown,
      },
      entries: entries.map((e) => ({
        entryId: e.entityId,
        title: e.body.title,
        body: e.body.body,
        tags: e.body.tags,
      })),
    });
    if (!actions.length) return;

    const source: SourceRef = {
      kind: 'handover',
      id: documentId,
      version: doc.version,
      label: task
        ? `Task #${task.body.number} handover v${doc.version}`
        : `${doc.body.title} v${doc.version}`,
    };
    await this.record.transaction(async (w) => {
      for (const a of actions) {
        const ctx = { actor: cmd.actor, reason: a.reason };
        if (a.kind === 'promote') {
          await this.fieldManual.promote(
            w,
            unitId,
            { title: a.title, body: a.body, tags: a.tags, pinned: false },
            source,
            ctx,
          );
        } else if (a.kind === 'merge') {
          await this.fieldManual.merge(w, a.entryId, source, a.body, ctx);
        } else {
          await this.fieldManual.retire(w, a.entryId, ctx);
        }
      }
      await this.fieldManual.rerender(w, unitId, {
        actor: cmd.actor,
        reason: `Curated from ${source.label}`,
      });
    });
  }
}
