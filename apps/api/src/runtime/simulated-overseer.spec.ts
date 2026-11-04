import { renderHandoverMarkdown } from '@orbot/shared';
import { SimulatedOverseer } from './simulated-overseer.js';
import { similarity, titleFrom } from '../common/similarity.js';

const o = new SimulatedOverseer();
const handover = (flags: string[], tried: string[] = []) =>
  renderHandoverMarkdown('T', {
    state: 's',
    nextSteps: [],
    triedAndFailed: tried,
    openProblems: [],
    flagsForSuccessor: flags,
  });

describe('SimulatedOverseer', () => {
  it('spreads a mission across the least-loaded bots', () => {
    const d = o.draftBackbrief({
      mission: { id: 'm', goal: 'G', definitionOfDone: ['a', 'b', 'c'], stage: null },
      unit: { id: 'u', name: 'Engineers', standingOrders: [] },
      repositories: [],
      bots: [
        { id: '1', callsign: 'E-1', role: 'dev', status: 'working', queueLength: 2 },
        { id: '2', callsign: 'E-2', role: 'dev', status: 'idle', queueLength: 0 },
        { id: '3', callsign: 'E-3', role: 'dev', status: 'stood-down', queueLength: 0 },
      ],
      fieldManual: [],
      commanderNotes: [],
      round: 1,
    });
    expect(d.proposedTasks.map((t) => t.botId)).toEqual(['2', '2', '2']);
  });

  it('After Action: findings left open are listed; what came up before is recommended (D130)', () => {
    const units = [
      { id: 'e', name: 'Engineers' },
      { id: 'i', name: 'Inspection' },
    ];
    const timeline = [
      {
        at: '1',
        unit: 'Inspection',
        kind: 'sendback',
        text: 'Sent back by Inspection: tests are missing.',
      },
      {
        at: '2',
        unit: 'Inspection',
        kind: 'sitrep',
        text: 'Finding (low) recorded, not fixed: touch targets below 24px.',
      },
    ];
    const first = o.afterAction({
      operation: { name: 'A', intent: 'x' },
      units,
      timeline,
      earlier: [],
      open: [],
    });
    expect(first.openFindings).toEqual([{ unitId: 'i', text: 'touch targets below 24px' }]);
    expect(first.lessons).toEqual([
      { unitId: 'i', text: 'Before handing over, check: tests are missing.' },
    ]);
    expect(first.recommendations).toEqual([]);
    const second = o.afterAction({
      operation: { name: 'B', intent: 'y' },
      units,
      timeline,
      earlier: [
        {
          operation: 'A',
          lessons: first.lessons.map((l) => l.text),
          openFindings: first.openFindings.map((f) => f.text),
        },
      ],
      open: [],
    });
    expect(second.recommendations).toEqual([
      {
        kind: 'rule',
        unitId: 'i',
        text: 'Before handing over, check: tests are missing.',
        why: 'Drawn again after Operation A.',
      },
      {
        kind: 'fix',
        unitId: 'i',
        text: 'Fix touch targets below 24px',
        why: 'Left open again after Operation A.',
      },
    ]);
  });

  it('promotes new lessons, merges repeats and retires what is marked obsolete', () => {
    const actions = o.curate({
      unit: { id: 'u', name: 'E' },
      handover: {
        documentId: 'h',
        version: 1,
        taskNumber: 7,
        markdown: handover(
          [
            'Warm the test cache first; the suite is slow cold',
            'Obsolete: Fax policy',
            'Brand new rule about logging format',
            'Nothing changed on orbot/task-7 yet',
          ],
          ['Caching the HTTP client'],
        ),
      },
      entries: [
        {
          entryId: 'e1',
          title: 'Warm the test cache',
          body: 'Warm the test cache first; the suite is slow when cold.',
          tags: [],
        },
        { entryId: 'e2', title: 'Fax policy', body: 'Fax everything.', tags: [] },
      ],
    });
    // Task-specific flags and tried-and-failed notes stay in the handover.
    expect(actions.map((a) => a.kind)).toEqual(['retire', 'merge', 'promote']);
    expect(actions[2]).toMatchObject({
      kind: 'promote',
      title: 'Brand new rule about logging format',
    });
  });

  it('scores cold starts down for each gap', () => {
    const a = o.assessColdStart({
      unit: { id: 'u', name: 'E' },
      task: { id: 't', number: 3, title: 'x', status: 'blocked' },
      lastHandover: null,
      fieldManual: [],
      recentDiary: [],
    });
    expect(a.score).toBe(50);
    expect(a.gaps.map((g) => g.description)).toEqual([
      expect.stringMatching(/has no handover/),
      expect.stringMatching(/Field Manual is empty/),
    ]);
  });
});

describe('similarity helpers', () => {
  it('treats reworded lessons as the same and different lessons as different', () => {
    expect(
      similarity('Warm the test cache first', 'Warm the test cache first; slow cold'),
    ).toBeGreaterThanOrEqual(0.5);
    expect(similarity('Warm the test cache', 'Prefix commit messages')).toBe(0);
  });
  it('makes short titles', () => {
    expect(titleFrom('prefix commit messages with `[ENG]` (unit convention). Always.')).toBe(
      'Prefix commit messages with [ENG] (unit convention)',
    );
  });
});
