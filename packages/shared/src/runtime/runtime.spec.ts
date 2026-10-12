import { parseHandoverMarkdown, renderHandoverMarkdown } from './runtime.js';

describe('handover markdown', () => {
  it('round-trips through render and parse', () => {
    const note = {
      state: 'Half done on orbot/task-7.',
      nextSteps: ['Write orbot/part-2.md', 'Run the tests'],
      triedAndFailed: ['Caching the client'],
      openProblems: [],
      flagsForSuccessor: ['Prefix commit messages with `[ENG]`'],
    };
    expect(parseHandoverMarkdown(renderHandoverMarkdown('Task #7', note))).toEqual(note);
  });

  it('tolerates human edits (extra text, * bullets)', () => {
    const md = '# Handover\n\nintro\n\n## Next Steps\n* do a thing\n\nsome prose\n\n## State\nok';
    expect(parseHandoverMarkdown(md)).toMatchObject({ state: 'ok', nextSteps: ['do a thing'] });
  });
});
