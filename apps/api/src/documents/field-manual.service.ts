import { ConflictException, Injectable } from '@nestjs/common';
import type { FmEntryBody, RecordVersion, SourceRef } from '@orbot/shared';
import type { RecordWriter, WriteContext } from '../record/record.service.js';
import { RecordService } from '../record/record.service.js';

export interface NewEntry {
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
}

const sourceKey = (s: SourceRef) => `${s.kind}:${s.id ?? ''}:${s.version ?? ''}`;

/** Markdown for the Field Manual. `markers` adds hidden entry ids so file edits can be mapped back. */
export function renderFieldManual(
  unitName: string,
  entries: RecordVersion<FmEntryBody>[],
  opts: { markers: boolean },
): string {
  const lines = [
    `# ${unitName} Field Manual`,
    '',
    '> Curated by the Overseer from handovers and the War Diary. Every change is versioned; nothing is deleted.',
    '',
  ];
  if (!entries.length) lines.push('_No entries yet._', '');
  for (const e of entries) {
    lines.push(`## ${e.body.title}`);
    if (opts.markers) lines.push(`<!-- fm:${e.entityId} -->`);
    lines.push('', e.body.body.trim(), '');
    if (e.body.sources.length)
      lines.push(`_Sources: ${e.body.sources.map((s) => s.label).join('; ')}_`, '');
  }
  return lines.join('\n');
}

export interface ParsedFmSection {
  entryId: string | null;
  title: string;
  body: string;
}

/** Parse a (possibly hand-edited) Field Manual file back into sections. */
export function parseFieldManual(md: string): ParsedFmSection[] {
  const parts = md.split(/^## /m).slice(1);
  return parts.map((part) => {
    const [titleLine, ...rest] = part.split('\n');
    let entryId: string | null = null;
    const body = rest
      .filter((l) => {
        const m = /^<!--\s*fm:([0-9a-f-]{36})\s*-->$/.exec(l.trim());
        if (m) entryId = m[1]!;
        return !m && !/^_Sources:.*_$/.test(l.trim());
      })
      .join('\n')
      .trim();
    return { entryId, title: titleLine!.trim(), body };
  });
}

/**
 * The Field Manual: one versioned `fm-entry` per lasting lesson (with provenance),
 * plus the unit's `field-manual` document, re-rendered in the same transaction so
 * whole-document history, diff and as-of work like any other document.
 */
@Injectable()
export class FieldManualService {
  constructor(private readonly record: RecordService) {}

  async entries(
    unitId: string,
    opts: { retired?: boolean } = {},
  ): Promise<RecordVersion<FmEntryBody>[]> {
    const all = await this.record.listActive('fm-entry', { unitId });
    return sortEntries(all.filter((e) => e.body.retired === !!opts.retired));
  }

  async document(unitId: string) {
    const [doc] = await this.record.listActive('document', {
      unitId,
      bodyContains: { kind: 'field-manual' },
    });
    return doc ?? null;
  }

  async promote(
    w: RecordWriter,
    unitId: string,
    entry: NewEntry,
    source: SourceRef,
    ctx: WriteContext,
  ) {
    const created = await w.create(
      'fm-entry',
      { unitId, ...entry, retired: false, retiredReason: null, sources: [source] },
      ctx,
    );
    await w.event(
      'curation',
      {
        action: 'promote',
        entryId: created.entityId,
        title: entry.title,
        sources: [source.label],
        reason: ctx.reason,
      },
      { unitId },
      ctx.actor,
    );
    return created;
  }

  /** Record that another source teaches the same lesson (and optionally refine the text). */
  async merge(
    w: RecordWriter,
    entryId: string,
    source: SourceRef,
    body: string | null,
    ctx: WriteContext,
  ) {
    const current = await w.getActive('fm-entry', entryId);
    if (!current || current.body.retired) return null;
    const known = current.body.sources.some((s) => sourceKey(s) === sourceKey(source));
    if (known && (body === null || body === current.body.body)) return current;
    const next = await w.revise(
      'fm-entry',
      entryId,
      (e) => ({ ...e, body: body ?? e.body, sources: known ? e.sources : [...e.sources, source] }),
      ctx,
    );
    await w.event(
      'curation',
      {
        action: 'merge',
        entryId,
        title: current.body.title,
        sources: [source.label],
        reason: ctx.reason,
      },
      { unitId: current.body.unitId },
      ctx.actor,
    );
    return next;
  }

  /** Retire an outdated entry: it leaves the active Field Manual and lives on in the archive. */
  async retire(w: RecordWriter, entryId: string, ctx: WriteContext & { expectedVersion?: number }) {
    const current = await w.getActive('fm-entry', entryId);
    if (!current) return null;
    if (current.body.retired) throw new ConflictException('That entry is already retired.');
    const next = await w.revise(
      'fm-entry',
      entryId,
      (e) => ({ ...e, retired: true, retiredReason: ctx.reason }),
      ctx,
    );
    await w.event(
      'curation',
      { action: 'retire', entryId, title: current.body.title, sources: [], reason: ctx.reason },
      { unitId: current.body.unitId },
      ctx.actor,
    );
    return next;
  }

  /** Bring a retired entry back into the active Field Manual (a new version; history kept). */
  async reinstate(
    w: RecordWriter,
    entryId: string,
    ctx: WriteContext & { expectedVersion?: number },
  ) {
    const current = await w.getActive('fm-entry', entryId);
    if (!current) return null;
    if (!current.body.retired) throw new ConflictException('That entry is not retired.');
    const next = await w.revise(
      'fm-entry',
      entryId,
      (e) => ({ ...e, retired: false, retiredReason: null }),
      ctx,
    );
    await w.event(
      'curation',
      {
        action: 'edit',
        entryId,
        title: current.body.title,
        sources: [],
        reason: `Reinstated: ${ctx.reason}`,
      },
      { unitId: current.body.unitId },
      ctx.actor,
    );
    return next;
  }

  async edit(
    w: RecordWriter,
    entryId: string,
    patch: { title?: string; body?: string; pinned?: boolean },
    source: SourceRef,
    ctx: WriteContext & { expectedVersion?: number },
  ) {
    const current = await w.getActive('fm-entry', entryId);
    if (!current) return null;
    const next = await w.revise(
      'fm-entry',
      entryId,
      (e) => ({
        ...e,
        title: patch.title ?? e.title,
        body: patch.body ?? e.body,
        pinned: patch.pinned ?? e.pinned,
        sources: e.sources.some((s) => sourceKey(s) === sourceKey(source))
          ? e.sources
          : [...e.sources, source],
      }),
      ctx,
    );
    if (next.version !== current.version) {
      await w.event(
        'curation',
        {
          action: 'edit',
          entryId,
          title: next.body.title,
          sources: [source.label],
          reason: ctx.reason,
        },
        { unitId: current.body.unitId },
        ctx.actor,
      );
    }
    return next;
  }

  /** Re-render the unit's Field Manual document from its active entries (inside `w`). */
  async rerender(w: RecordWriter, unitId: string, ctx: WriteContext) {
    const unit = await w.getActive('unit', unitId);
    if (!unit) return;
    const entries = sortEntries(
      (await w.listActive('fm-entry', { unitId })).filter((e) => !e.body.retired),
    );
    const markdown = renderFieldManual(unit.body.name, entries, { markers: false });
    const [doc] = await w.listActive('document', {
      unitId,
      bodyContains: { kind: 'field-manual' },
    });
    if (doc) {
      await w.revise('document', doc.entityId, (d) => ({ ...d, markdown }), ctx);
    } else {
      await w.create(
        'document',
        {
          kind: 'field-manual',
          unitId,
          title: `${unit.body.name} Field Manual`,
          markdown,
          taskId: null,
          botId: null,
        },
        ctx,
      );
    }
  }
}

export function sortEntries(entries: RecordVersion<FmEntryBody>[]): RecordVersion<FmEntryBody>[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.body.pinned) - Number(a.body.pinned) || a.body.title.localeCompare(b.body.title),
  );
}
