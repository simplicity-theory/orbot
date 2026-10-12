import type { RecordEvent } from '@orbot/shared';
import { describeEvent } from './describe-event';

const ev = (kind: RecordEvent['kind'], body: unknown): RecordEvent =>
  ({
    id: 'x',
    seq: 1,
    kind,
    unitId: null,
    botId: null,
    taskId: null,
    operationId: null,
    missionId: null,
    actor: 'bot:1',
    body,
    createdAt: new Date().toISOString(),
  }) as RecordEvent;

describe('describeEvent', () => {
  it('describes credential use by name only', () => {
    expect(
      describeEvent(ev('credential.used', { secretName: 'deploy-token', purpose: 'push main' }))
        .text,
    ).toBe('Used deploy-token to push main');
  });

  it('keeps full file paths but shortens commit hashes', () => {
    expect(
      describeEvent(
        ev('artifact', {
          kind: 'file',
          ref: 'orbot/task-101.md',
          summary: 'Edited orbot/task-101.md',
        }),
      ).text,
    ).toBe('Edited orbot/task-101.md');
    expect(
      describeEvent(
        ev('artifact', { kind: 'commit', ref: '2913a5784e4b1b2f0b4d', summary: 'Task #1' }),
      ).text,
    ).toBe('Task #1 (2913a5784e)');
  });

  it('marks failures as danger', () => {
    expect(
      describeEvent(ev('task.status', { from: 'working', to: 'failed', reason: 'tests' })).tone,
    ).toBe('danger');
  });
});
