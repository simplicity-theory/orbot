import type { EntityBodyMap, EntityType } from '@orbot/shared';

/** Human title stored alongside each version (used in search results and history). */
export function titleOf<T extends EntityType>(type: T, body: EntityBodyMap[T]): string {
  const b = body as EntityBodyMap[EntityType];
  switch (type) {
    case 'unit':
      return (b as EntityBodyMap['unit']).name;
    case 'bot':
      return `Bot ${(b as EntityBodyMap['bot']).callsign}`;
    case 'operation':
      return `Operation ${(b as EntityBodyMap['operation']).name}`;
    case 'mission':
      return (b as EntityBodyMap['mission']).goal;
    case 'task': {
      const t = b as EntityBodyMap['task'];
      return `Task #${t.number}: ${t.title}`;
    }
    case 'supply':
      return (b as EntityBodyMap['supply']).name;
    case 'document':
      return (b as EntityBodyMap['document']).title;
    default:
      return type;
  }
}

/** Flattened searchable text: every string value in the body. */
export function searchableText(body: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(body);
  return out.join('\n');
}

/** Deterministic JSON (sorted keys) so diffs between versions are stable. */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}

/** The text a version is diffed on: Markdown for documents, stable JSON otherwise. */
export function diffableText(type: string, body: unknown): string {
  if (type === 'document' && body && typeof body === 'object' && 'markdown' in body) {
    return String((body as { markdown: unknown }).markdown);
  }
  return stableStringify(body);
}
