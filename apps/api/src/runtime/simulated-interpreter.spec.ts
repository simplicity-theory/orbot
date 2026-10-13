import type { InterpretInput, InterpretUnit } from '@orbot/shared';
import { SimulatedInterpreter } from './simulated-interpreter.js';

const unit = (over: Partial<InterpretUnit> = {}): InterpretUnit => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Guard',
  slug: 'guard',
  standingOrders: [
    { id: 'hi', text: 'High and critical findings block release.' },
    { id: 'lo', text: 'Low-severity findings also block release.' },
  ],
  supplyIds: [],
  computeBudget: 0,
  halted: false,
  bots: [
    {
      id: '00000000-0000-4000-8000-0000000000d1',
      callsign: 'G-1',
      status: 'working',
      halted: false,
    },
  ],
  tasks: [
    {
      id: '00000000-0000-4000-8000-0000000000b1',
      number: 7,
      title: 'Build the mobile layout',
      status: 'working',
      statusReason: null,
      missionId: null,
      botCallsign: 'G-1',
      kind: 'work',
    },
  ],
  missions: [],
  ...over,
});
const input = (message: string, over: Partial<InterpretInput> = {}): InterpretInput => ({
  message,
  channelUnitId: '00000000-0000-4000-8000-0000000000a1',
  units: [unit()],
  depot: [
    {
      id: '00000000-0000-4000-8000-0000000000c1',
      name: 'payments-service',
      kind: 'repository',
      connected: true,
      tier: null,
    },
    {
      id: '00000000-0000-4000-8000-0000000000c2',
      name: 'production',
      kind: 'environment',
      connected: true,
      tier: 'production',
    },
  ],
  operations: [],
  allHalted: false,
  ...over,
});
const i = new SimulatedInterpreter();

describe('SimulatedInterpreter', () => {
  it('splits a message into a rule change and a supply grant', () => {
    const r = i.interpret(
      input('Stop blocking on low-severity findings. I’ll give you access to the payments repo.'),
    );
    expect(r.kinds).toEqual(['rule-change', 'supply-grant']);
    expect(r.actions[0]).toMatchObject({
      kind: 'rule-change',
      removeOrders: ['lo'],
      addOrders: ['Stop blocking on low-severity findings.'],
    });
    expect(r.actions[1]).toMatchObject({
      kind: 'supply-grant',
      supplyId: '00000000-0000-4000-8000-0000000000c1',
    });
  });

  it.each([
    ['How far along is the mobile layout?', 'question'],
    ['Add rate limiting to the API.', 'order'],
    ['Drop the mobile layout for now.', 'frago'],
    ['From now on, scan every branch.', 'rule-change'],
    ['I might give you more budget.', 'musing'],
  ])('%s → %s', (msg, kind) => {
    expect(i.interpret(input(msg)).kinds).toEqual([kind]);
  });

  it('answers questions from the record', () => {
    expect(i.interpret(input('How far along is the mobile layout?')).answer).toBe(
      'Task #7 “Build the mobile layout” (Guard) is working with G-1.',
    );
  });

  it('holds musings as possible actions, changing nothing', () => {
    const r = i.interpret(input('Maybe I could give you 5 more units of budget.'));
    expect(r.actions).toEqual([]);
    expect(r.musings).toEqual([expect.objectContaining({ kind: 'budget-grant', units: 5 })]);
  });

  it('names what is missing from the depot', () => {
    expect(i.interpret(input('I’ll give you access to the billing repo.')).missing).toEqual([
      { what: 'billing repository', kind: 'repository' },
    ]);
  });

  it('routes orders that name another unit', () => {
    const eng = unit({
      id: '00000000-0000-4000-8000-0000000000a2',
      name: 'Engineers',
      slug: 'engineers',
      standingOrders: [],
      tasks: [],
    });
    const r = i.interpret(input('Engineers, fix the login bug.', { units: [unit(), eng] }));
    expect(r.actions[0]).toMatchObject({
      kind: 'create-mission',
      unitId: eng.id,
      goal: 'Fix the login bug',
    });
  });

  it('recognises production deploy rights', () => {
    expect(i.interpret(input('Grant Guard production deploy rights.')).actions[0]).toMatchObject({
      kind: 'grant-deploy-rights',
    });
  });

  describe('stand down', () => {
    const G = '00000000-0000-4000-8000-0000000000a1';
    const BOT = '00000000-0000-4000-8000-0000000000d1';

    it('stands the addressed unit down, with the reason given', () => {
      expect(i.interpret(input('Stand down until the audit is over.')).actions).toEqual([
        { kind: 'stand-down', unitId: G, scope: 'unit', targetId: G, reason: 'The audit is over' },
      ]);
    });

    it('stands everything down from any channel', () => {
      const r = i.interpret(input('Everyone, stand down.', { channelUnitId: null }));
      expect(r.actions[0]).toMatchObject({ kind: 'stand-down', scope: 'all', targetId: null });
    });

    it('stands one bot down by callsign', () => {
      expect(i.interpret(input('G-1, stand down.')).actions[0]).toMatchObject({
        kind: 'stand-down',
        scope: 'bot',
        targetId: BOT,
      });
    });

    it('treats “stand down <work>” as a frago, not a halt', () => {
      expect(i.interpret(input('Stand down the mobile layout.')).actions[0]).toMatchObject({
        kind: 'frago',
        change: 'stand-down',
      });
    });

    it('lifts the order it is under, and says when there is none', () => {
      const halted = input('Resume work.', { units: [unit({ halted: true })] });
      expect(i.interpret(halted).actions[0]).toMatchObject({
        kind: 'lift-stand-down',
        scope: 'unit',
      });
      expect(i.interpret(input('As you were.')).unclear[0]).toContain('not stood down');
      const all = input('Back to work, everyone.', { channelUnitId: null, allHalted: true });
      expect(i.interpret(all).actions[0]).toMatchObject({ kind: 'lift-stand-down', scope: 'all' });
    });

    it('holds a hedged stand-down as a musing', () => {
      const r = i.interpret(input('I might stand everyone down.'));
      expect(r.actions).toEqual([]);
      expect(r.musings[0]).toMatchObject({ kind: 'stand-down', scope: 'all' });
    });
  });

  describe('main effort', () => {
    const LOGIN = '00000000-0000-4000-8000-0000000000e1';
    const AUDIT = '00000000-0000-4000-8000-0000000000e2';
    const ops = {
      channelUnitId: null,
      operations: [
        { id: LOGIN, name: 'Login Rate Limiting', phase: 'execution' },
        { id: AUDIT, name: 'Audit Trail', phase: 'execution' },
      ],
    };

    it('names the operation, with the reason given, from any channel', () => {
      expect(
        i.interpret(
          input('Make login rate limiting the main effort because the launch is Friday.', ops),
        ).actions,
      ).toEqual([
        { kind: 'main-effort', unitId: null, operationId: LOGIN, reason: 'The launch is Friday' },
      ]);
      expect(
        i.interpret(input('Main effort is the audit trail.', { ...ops, channelUnitId: undefined }))
          .actions[0],
      ).toMatchObject({ kind: 'main-effort', operationId: AUDIT });
    });

    it('asks which operation when it cannot tell', () => {
      expect(i.interpret(input('Make this the main effort.', ops)).unclear[0]).toContain(
        'which operation? Under way: Login Rate Limiting, Audit Trail',
      );
    });

    it('clears it, and answers what it is', () => {
      const named = { ...ops, mainEffortOperationId: LOGIN };
      expect(i.interpret(input('No main effort any more.', named)).actions[0]).toMatchObject({
        kind: 'main-effort',
        operationId: null,
      });
      expect(i.interpret(input('Clear the main effort.', ops)).unclear[0]).toContain(
        'there is no main effort',
      );
      expect(i.interpret(input('What is the main effort?', named)).answer).toBe(
        'The main effort is Operation Login Rate Limiting (execution): its tasks go first.',
      );
    });

    it('holds a hedged main effort as a musing', () => {
      const r = i.interpret(input('Maybe the audit trail should be the main effort.', ops));
      expect(r.actions).toEqual([]);
      expect(r.musings[0]).toMatchObject({ kind: 'main-effort', operationId: AUDIT });
    });
  });
});
