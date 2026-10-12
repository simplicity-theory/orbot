import type { FmEntryBody, RecordVersion } from '@orbot/shared';
import { parseFieldManual, renderFieldManual } from './field-manual.service.js';

const entry = (id: string, title: string, body: string): RecordVersion<FmEntryBody> => ({
  id: `v-${id}`,
  entityType: 'fm-entry',
  entityId: id,
  version: 1,
  unitId: 'u',
  actor: 'x',
  reason: 'x',
  createdAt: new Date().toISOString(),
  body: {
    unitId: 'u',
    title,
    body,
    tags: [],
    pinned: false,
    retired: false,
    retiredReason: null,
    sources: [{ kind: 'commander', id: null, version: null, label: 'Commander' }],
  },
});

describe('Field Manual markdown', () => {
  it('round-trips entries through the file format, ignoring source lines', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const md = renderFieldManual('Engineers', [entry(id, 'Branching', 'One task, one branch.')], {
      markers: true,
    });
    expect(parseFieldManual(md)).toEqual([
      { entryId: id, title: 'Branching', body: 'One task, one branch.' },
    ]);
  });

  it('reads sections humans added without markers as new entries', () => {
    expect(parseFieldManual('# FM\n\n## Pairing\n\nPair on auth.\n')).toEqual([
      { entryId: null, title: 'Pairing', body: 'Pair on auth.' },
    ]);
  });
});
