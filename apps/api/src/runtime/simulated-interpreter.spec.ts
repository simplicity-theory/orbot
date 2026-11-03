import { DEFAULT_HOLD_POLICY, type InterpretInput, type InterpretUnit } from '@orbot/shared';
import { SimulatedInterpreter } from './simulated-interpreter.js';

const unit = (over: Partial<InterpretUnit> = {}): InterpretUnit => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Guard',
  slug: 'guard',
  holdPolicy: DEFAULT_HOLD_POLICY,
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
  history: [],
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
  describe('operation resources', () => {
    const OP = '00000000-0000-4000-8000-0000000000e1';
    const REPO = '00000000-0000-4000-8000-0000000000c1';
    const PROD = '00000000-0000-4000-8000-0000000000c2';
    const hq = (message: string) =>
      input(message, {
        channelUnitId: null,
        operations: [{ id: OP, name: 'Ledger', phase: 'o-group', supplyIds: [] }],
      });

    it('assigns depot items to an operation, by name', () => {
      const r = i.interpret(hq('Use payments-service and production for Operation Ledger.'));
      expect(r.actions).toEqual([
        { kind: 'assign-resource', unitId: null, operationId: OP, supplyId: REPO },
        { kind: 'assign-resource', unitId: null, operationId: OP, supplyId: PROD },
      ]);
      expect(r.missing).toEqual([]);
    });

    it('takes one off, and says what it could not find', () => {
      const r = i.interpret(hq('Take the production environment off Operation Ledger.'));
      expect(r.actions).toEqual([
        { kind: 'release-resource', unitId: null, operationId: OP, supplyId: PROD },
      ]);
      const m = i.interpret(hq('Assign billing-api to Operation Ledger.'));
      expect(m.actions).toEqual([]);
      expect(m.missing).toEqual([{ what: 'billing-api', kind: 'supply' }]);
    });

    it('asks which operation when none matches', () => {
      const r = i.interpret(
        input('Use payments-service for operation Nowhere.', {
          channelUnitId: null,
          operations: [
            { id: OP, name: 'Ledger', phase: 'o-group' },
            { id: '00000000-0000-4000-8000-0000000000e2', name: 'Audit', phase: 'execution' },
          ],
        }),
      );
      expect(r.unclear[0]).toContain('which operation? Under way: Ledger, Audit.');
    });

    it('changes the main repository: named, or found by the repository it moves from', () => {
      const SUB = '00000000-0000-4000-8000-0000000000c3';
      const two = (message: string) =>
        input(message, {
          channelUnitId: null,
          depot: [
            ...input('').depot,
            { id: SUB, name: 'subframe', kind: 'repository', connected: true, tier: null },
          ],
          operations: [
            { id: OP, name: 'whispering willows', phase: 'execution', supplyIds: [REPO] },
            { id: '00000000-0000-4000-8000-0000000000e2', name: 'Audit', phase: 'execution' },
          ],
        });
      const want = [{ kind: 'set-main-repository', unitId: null, operationId: OP, supplyId: SUB }];
      expect(i.interpret(two('change the repo from payments-service to subframe')).actions).toEqual(
        want,
      );
      expect(
        i.interpret(two('Make subframe the main repository of Operation whispering willows.'))
          .actions,
      ).toEqual(want);
      expect(i.interpret(two('Move operation whispering willows to subframe.')).actions).toEqual(
        want,
      );
      // Not a repository, or not in the depot: said, not done.
      expect(
        i.interpret(two('change the repo from payments-service to production')).missing,
      ).toEqual([{ what: 'production', kind: 'supply' }]);
      expect(i.interpret(two('change the repo to subframe')).unclear[0]).toContain(
        'which operation? Under way: whispering willows, Audit.',
      );
    });

    it('cancels an operation, with why', () => {
      expect(i.interpret(hq('Cancel operation Ledger: wrong approach.')).actions).toEqual([
        { kind: 'cancel-operation', unitId: null, operationId: OP, note: 'wrong approach' },
      ]);
      expect(i.interpret(hq('Call off the operation.')).actions).toEqual([
        { kind: 'cancel-operation', unitId: null, operationId: OP, note: '' },
      ]);
    });

    it('sets an operation’s hold policy, or clears it', () => {
      const r = i.interpret(hq('Operation Ledger: automatic, nothing ever holds.'));
      expect(r.actions).toEqual([
        {
          kind: 'hold-policy',
          unitId: null,
          operationId: OP,
          policy: { holdFrom: 'never', fixUpTo: 'small' },
        },
      ]);
      expect(
        i.interpret(
          hq('For Operation Ledger, hold only on critical findings and fix up to medium.'),
        ).actions,
      ).toEqual([expect.objectContaining({ policy: { holdFrom: 'critical', fixUpTo: 'medium' } })]);
      expect(i.interpret(hq("Operation Ledger: back to the units' own settings.")).actions).toEqual(
        [{ kind: 'hold-policy', unitId: null, operationId: OP, policy: null }],
      );
    });

    it('starts a new project, with the rest of the sentence as the intent', () => {
      const r = i.interpret(
        hq('Start a new project called Ledger: a personal ledger that works offline.'),
      );
      expect(r.kinds).toEqual(['order']);
      expect(r.actions).toEqual([
        {
          kind: 'new-project',
          unitId: null,
          name: 'Ledger',
          projectKind: 'single-html',
          intent: 'A personal ledger that works offline.',
        },
      ]);
      expect(i.interpret(hq('New project "Scratch Pad"')).actions).toEqual([
        expect.objectContaining({ kind: 'new-project', name: 'Scratch Pad', intent: null }),
      ]);
      // Hedged: a musing, not an order. To a unit, not HQ: not a project.
      expect(i.interpret(hq('Maybe start a new project called Notes.')).musings).toEqual([
        expect.objectContaining({ kind: 'new-project', name: 'Notes' }),
      ]);
      expect(i.interpret(input('Start a new project called Notes.')).actions).toEqual([]);
    });

    it('launches an operation with resources named in the intent', () => {
      const r = i.interpret(hq('Add audit logging to payments, using payments-service.'));
      expect(r.actions).toEqual([
        expect.objectContaining({
          kind: 'create-operation',
          intent: 'Add audit logging to payments.',
          supplyIds: [REPO],
        }),
      ]);
    });
  });

  it('sets the unit’s hold policy from a sentence, keeping what it does not mention', () => {
    expect(i.interpret(input('Hold only on critical findings.')).actions).toEqual([
      {
        kind: 'hold-policy',
        unitId: '00000000-0000-4000-8000-0000000000a1',
        operationId: null,
        policy: { holdFrom: 'critical', fixUpTo: 'small' },
      },
    ]);
    expect(i.interpret(input('Go fully automatic: fix anything, never hold.')).actions).toEqual([
      expect.objectContaining({
        kind: 'hold-policy',
        policy: { holdFrom: 'never', fixUpTo: 'large' },
      }),
    ]);
    expect(i.interpret(input('Only record findings, never fix them.')).actions).toEqual([
      expect.objectContaining({
        kind: 'hold-policy',
        policy: { holdFrom: 'high', fixUpTo: 'none' },
      }),
    ]);
    expect(i.interpret(input('Only record findings, never fix them.')).kinds).toEqual([
      'rule-change',
    ]);
  });

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

  describe('recon', () => {
    it('sends the addressed unit on recon, with the repository named', () => {
      expect(
        i.interpret(input('Recon the payments repo: how are card numbers stored?')).actions,
      ).toEqual([
        {
          kind: 'recon',
          unitId: '00000000-0000-4000-8000-0000000000a1',
          question: 'How are card numbers stored',
          repoSupplyId: '00000000-0000-4000-8000-0000000000c1',
        },
      ]);
      expect(i.interpret(input('Scout out how login is rate limited.')).actions[0]).toMatchObject({
        kind: 'recon',
        question: 'How login is rate limited',
        repoSupplyId: null,
      });
    });

    it('says what is missing when the repository is not connected', () => {
      expect(i.interpret(input('Recon the billing repo for retries.')).missing).toEqual([
        { what: 'a repository named “billing”', kind: 'repository' },
      ]);
    });
  });

  it('rehearses an operation on the sand table, never as a musing', () => {
    const ops = {
      channelUnitId: null,
      operations: [
        { id: '00000000-0000-4000-8000-0000000000e1', name: 'Ledger', phase: 'backbrief' },
      ],
    };
    expect(i.interpret(input('Rehearse Ledger on the sand table.', ops)).actions).toEqual([
      { kind: 'rehearse', unitId: null, operationId: '00000000-0000-4000-8000-0000000000e1' },
    ]);
  });

  it('takes an issue from the connected tracker on as a mission', () => {
    const trackers = [{ id: '00000000-0000-4000-8000-0000000000f1', name: 'GitHub acme/app' }];
    expect(i.interpret(input('Take on issue #7.', { trackers })).actions).toEqual([
      {
        kind: 'take-issue',
        unitId: '00000000-0000-4000-8000-0000000000a1',
        connectionId: '00000000-0000-4000-8000-0000000000f1',
        number: 7,
      },
    ]);
    expect(i.interpret(input('Take on issue #7.')).missing).toEqual([
      { what: 'an issue tracker', kind: 'supply' },
    ]);
  });

  describe('permission requests (rules of engagement)', () => {
    const asking = unit({
      tasks: [
        {
          id: '00000000-0000-4000-8000-0000000000b2',
          number: 9,
          title: 'Format dates',
          status: 'awaiting-approval',
          statusReason: 'Asks permission: Add a new dependency',
          missionId: null,
          botCallsign: 'G-1',
          kind: 'deploy',
        },
      ],
    });

    it('gives permission to the bot that asked', () => {
      const r = i.interpret(input('Give G-1 permission.', { units: [asking] }));
      expect(r.actions).toEqual([
        {
          kind: 'decide-permission',
          unitId: asking.id,
          taskId: '00000000-0000-4000-8000-0000000000b2',
          approve: true,
          note: null,
        },
      ]);
    });

    it('refuses with the reason given, and asks for one if there is none', () => {
      const r = i.interpret(
        input('Refuse the request: use the standard library', { units: [asking] }),
      );
      expect(r.actions[0]).toMatchObject({ approve: false, note: 'use the standard library' });
      const bare = i.interpret(input('Refuse the request.', { units: [asking] }));
      expect(bare.actions).toEqual([]);
      expect(bare.unclear[0]).toMatch(/say why you refuse/);
    });

    it('a deploy approval does not decide a permission request', () => {
      const r = i.interpret(input('Approve the deploy.', { units: [asking] }));
      expect(r.actions).toEqual([]);
    });

    it('says so when no bot is waiting', () => {
      expect(i.interpret(input('Give permission.')).unclear[0]).toMatch(
        /no bot is waiting for permission/,
      );
    });
  });
});
