import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type { RecordEvent, RecordVersion, UnitBody } from '@orbot/shared';
import type { AppConfig } from '../config/config.js';
import { Background } from '../common/background.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService } from '../record/record.service.js';
import { type DocsLocation, GitDocumentStore, type UnitDocumentStore } from './document-store.js';
import {
  FieldManualService,
  parseFieldManual,
  renderFieldManual,
  sortEntries,
} from './field-manual.service.js';

export const UNIT_DOCUMENT_STORE = Symbol('UNIT_DOCUMENT_STORE');
export const DOCS_ACTOR = 'system:docs';
export const GIT_IMPORT_ACTOR = 'system:git-import';

const norm = (s: string) => s.replace(/[ \t]+$/gm, '').trim();

/**
 * Keeps every unit's documents as Markdown files in the unit's repository
 * (Field Manual, standing orders, handovers, War Diary), mirrored from the record.
 * The record is the source of truth for history and search; edits humans make to
 * the files are imported back as new versions before every briefing.
 */
@Injectable()
export class UnitDocsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly dirty = new Set<string>();
  private sub: Subscription | undefined;

  constructor(
    @Inject(UNIT_DOCUMENT_STORE) private readonly store: UnitDocumentStore,
    private readonly record: RecordService,
    private readonly fieldManual: FieldManualService,
    private readonly bus: RecordBus,
    private readonly background: Background,
  ) {}

  onApplicationBootstrap(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type === 'version') {
        if (['fm-entry', 'document', 'unit'].includes(n.version.entityType) && n.version.unitId) {
          this.schedule(n.version.unitId);
        }
      } else if (n.event.kind === 'diary.entry' && n.event.unitId) {
        this.schedule(n.event.unitId);
      }
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  /** Mirror a unit's documents soon (coalesced: many changes, one commit). */
  schedule(unitId: string): void {
    if (this.dirty.has(unitId)) return;
    this.dirty.add(unitId);
    this.background.run(`docs:${unitId}`, 'docs-mirror', async () => {
      if (!this.dirty.delete(unitId)) return;
      await this.mirror(unitId, 'Update unit documents');
    });
  }

  async location(unit: RecordVersion<UnitBody>): Promise<DocsLocation | null> {
    for (const id of unit.body.supplyIds) {
      const s = await this.record.getActive('supply', id);
      if (s?.body.connected && s.body.spec.kind === 'repository') {
        return {
          repoSupplyId: id,
          repoPath: s.body.spec.localPath,
          defaultBranch: s.body.spec.defaultBranch,
        };
      }
    }
    return null;
  }

  async describe(unitId: string) {
    const unit = await this.record.requireActive('unit', unitId);
    const loc = await this.location(unit);
    if (!loc) return null;
    const supply = await this.record.requireActive('supply', loc.repoSupplyId);
    return { repository: supply.body.name, ...this.store.describe(loc, unit.body.slug) };
  }

  /** Every file as the record says it should read. */
  async render(unit: RecordVersion<UnitBody>): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const u = unit.body;
    files.set(
      'README.md',
      [
        `# ${u.name} — unit documents`,
        '',
        `Kept by ORBOT for the ${u.name} unit (${u.role}). Mirrored from the permanent record, which keeps every version.`,
        '',
        '- `field-manual.md` — lasting lessons. Edit freely: changes are imported as new versions.',
        '- `standing-orders.md` — rules that always apply. Edit freely.',
        '- `handovers/` — one per task, written by the bot that worked it. Edit freely.',
        '- `war-diary/` — the War Diary, the running log. Read-only: diary entries are immutable, edits are restored.',
        '',
      ].join('\n'),
    );
    files.set(
      'field-manual.md',
      renderFieldManual(u.name, await this.fieldManual.entries(unit.entityId), { markers: true }),
    );
    files.set(
      'standing-orders.md',
      [
        `# ${u.name} standing orders`,
        '',
        ...u.standingOrders.map((o) => `- ${o.text} <!-- so:${o.id} -->`),
        '',
      ].join('\n'),
    );

    const tasks = new Map(
      (await this.record.listActive('task', { unitId: unit.entityId })).map((t) => [
        t.entityId,
        t.body,
      ]),
    );
    const handovers = await this.record.listActive('document', {
      unitId: unit.entityId,
      bodyContains: { kind: 'handover' },
    });
    for (const h of handovers) {
      const n = h.body.taskId ? tasks.get(h.body.taskId)?.number : null;
      files.set(`handovers/${n ? `task-${n}` : h.entityId}.md`, h.body.markdown.trimEnd() + '\n');
    }

    const bots = new Map(
      (await this.record.listActive('bot', { unitId: unit.entityId })).map((b) => [
        b.entityId,
        b.body.callsign,
      ]),
    );
    const diary = await this.record.listEvents(
      { unitId: unit.entityId, kinds: ['diary.entry'], limit: 1000 },
      { latest: true },
    );
    const byDay = new Map<string, RecordEvent<'diary.entry'>[]>();
    for (const e of diary as RecordEvent<'diary.entry'>[]) {
      const day = e.createdAt.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), e]);
    }
    for (const [day, events] of byDay) {
      files.set(
        `war-diary/${day}.md`,
        [
          `# ${u.name} War Diary — ${day}`,
          '',
          ...events.map(
            (e) =>
              `- ${e.createdAt.slice(11, 19)} · ${e.botId ? (bots.get(e.botId) ?? 'bot') : 'unit'} · ${e.body.category}: ${e.body.text}`,
          ),
          '',
        ].join('\n'),
      );
    }
    return files;
  }

  /** Write the files and commit. Records a `docs.synced` event when anything changed. */
  async mirror(unitId: string, reason: string, imported: string[] = []): Promise<string | null> {
    const unit = await this.record.getActive('unit', unitId);
    if (!unit) return null;
    const loc = await this.location(unit);
    if (!loc) return null;
    const { commit, changed } = await this.store.write(
      loc,
      unit.body.slug,
      await this.render(unit),
      `ORBOT: ${reason} (${unit.body.name})`,
    );
    if (commit || imported.length) {
      await this.record.event(
        'docs.synced',
        { commit, files: changed, imported },
        { unitId },
        DOCS_ACTOR,
      );
    }
    return commit;
  }

  /**
   * Import edits humans made to the files, as new versions in the record, then
   * re-mirror. Runs before every briefing so bots see the latest word.
   */
  async sync(unitId: string): Promise<string[]> {
    let imported: string[] = [];
    await new Promise<void>((resolve, reject) => {
      this.background.run(`docs:${unitId}`, 'docs-sync', async () => {
        try {
          imported = await this.importEdits(unitId);
          if (imported.length)
            await this.mirror(unitId, 'Import edits made in the repository', imported);
          resolve();
        } catch (err) {
          reject(err as Error);
        }
      });
    });
    return imported;
  }

  private async importEdits(unitId: string): Promise<string[]> {
    const unit = await this.record.getActive('unit', unitId);
    if (!unit) return [];
    const loc = await this.location(unit);
    if (!loc) return [];
    const onDisk = await this.store.read(loc, unit.body.slug);
    const expected = await this.render(unit);
    const changed = [...onDisk].filter(
      ([path, content]) => expected.has(path) && norm(expected.get(path)!) !== norm(content),
    );
    if (!changed.length) return [];

    const imported: string[] = [];
    const ctx = (path: string) => ({
      actor: GIT_IMPORT_ACTOR,
      reason: `Edited in the repository (${path})`,
    });
    const gitSource = (path: string) => ({
      kind: 'git' as const,
      id: null,
      version: null,
      label: `Repository edit to ${path}`,
    });

    await this.record.transaction(async (w) => {
      for (const [path, content] of changed) {
        if (path === 'field-manual.md') {
          const active = new Map(
            sortEntries(
              (await w.listActive('fm-entry', { unitId })).filter((e) => !e.body.retired),
            ).map((e) => [e.entityId, e]),
          );
          const sections = parseFieldManual(content);
          for (const s of sections) {
            const entry = s.entryId ? active.get(s.entryId) : undefined;
            if (entry) {
              if (entry.body.title !== s.title || norm(entry.body.body) !== norm(s.body)) {
                await this.fieldManual.edit(
                  w,
                  entry.entityId,
                  { title: s.title, body: s.body },
                  gitSource(path),
                  ctx(path),
                );
              }
            } else if (s.title) {
              await this.fieldManual.promote(
                w,
                unitId,
                { title: s.title, body: s.body, tags: [], pinned: false },
                gitSource(path),
                ctx(path),
              );
            }
          }
          const kept = new Set(sections.map((s) => s.entryId).filter(Boolean));
          for (const id of active.keys()) {
            if (!kept.has(id)) {
              await this.fieldManual.retire(w, id, {
                actor: GIT_IMPORT_ACTOR,
                reason: `Removed from ${path} in the repository`,
              });
            }
          }
          await this.fieldManual.rerender(w, unitId, ctx(path));
          imported.push(path);
        } else if (path === 'standing-orders.md') {
          const orders = content
            .split('\n')
            .map((l) => /^\s*[-*]\s+(.*?)(?:\s*<!--\s*so:(\S+)\s*-->)?\s*$/.exec(l))
            .filter((m): m is RegExpExecArray => !!m && !!m[1])
            .map((m) => ({ id: m[2] ?? `so-${randomUUID().slice(0, 8)}`, text: m[1]! }));
          await w.revise('unit', unitId, (u) => ({ ...u, standingOrders: orders }), ctx(path));
          imported.push(path);
        } else if (path.startsWith('handovers/')) {
          const n = Number(/task-(\d+)\.md$/.exec(path)?.[1]);
          const task = (await w.listActive('task', { unitId })).find((t) => t.body.number === n);
          const [doc] = task
            ? await w.listActive('document', {
                unitId,
                bodyContains: { kind: 'handover', taskId: task.entityId },
              })
            : [];
          if (doc) {
            await w.revise(
              'document',
              doc.entityId,
              (d) => ({ ...d, markdown: content }),
              ctx(path),
            );
            imported.push(path);
          }
        } else if (path.startsWith('war-diary/')) {
          // Diary entries are immutable events: the file is restored on the next mirror.
          imported.push(`${path} (read-only, restored)`);
        }
      }
    });
    return imported;
  }
}

export function createDocumentStore(config: AppConfig): UnitDocumentStore {
  return new GitDocumentStore(config.workspacesDir);
}
