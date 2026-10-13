import { withDefaults } from './record.service.js';

describe('reading old versions', () => {
  it('fills in fields added since the version was written', () => {
    const old = {
      irreversibleActions: ['grant-deploy-rights'],
      confirmationPhrase: 'confirm',
    };
    expect(withDefaults('settings', old)).toMatchObject({
      budgetWarnAt: 0.8,
      halt: null,
      mainEffort: null,
      mainEffortYield: true,
      dailyBrief: { enabled: true, at: '07:00', timeZone: 'UTC' },
      alerts: { enabled: false, credentialName: null },
    });
  });

  it('returns a version that no longer fits the schema as it was stored', () => {
    const odd = { name: 'x' };
    expect(withDefaults('unit', odd)).toBe(odd);
  });
});
