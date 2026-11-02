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
