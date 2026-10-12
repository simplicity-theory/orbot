import { Injectable } from '@nestjs/common';
import { CreateDocumentRequest, ReviseDocumentRequest } from '@orbot/shared';
import type { z } from 'zod';
import { RecordService, type WriteContext } from '../record/record.service.js';

/**
 * Unit documents in the record. (Phase 2 adds the Markdown-in-repo mirror behind
 * a storage interface; the record stays the source of history and search.)
 */
@Injectable()
export class DocumentsService {
  constructor(private readonly record: RecordService) {}

  create(input: z.output<typeof CreateDocumentRequest>, ctx: WriteContext) {
    return this.record.create(
      'document',
      { kind: input.kind, unitId: input.unitId, title: input.title, markdown: input.markdown, taskId: null, botId: null },
      ctx,
    );
  }

  /** A rewrite creates a new version; the old one is archived with who, when and why. */
  revise(id: string, input: z.output<typeof ReviseDocumentRequest>, actor: string) {
    return this.record.revise(
      'document',
      id,
      (d) => ({ ...d, markdown: input.markdown, title: input.title ?? d.title }),
      { actor, reason: input.reason, expectedVersion: input.expectedVersion },
    );
  }

  list(filter: { unitId?: string } = {}) {
    return this.record.listActive('document', filter);
  }

  get(id: string) {
    return this.record.requireActive('document', id);
  }
}
