import { Redactor, KNOWN_SECRET_MASK } from './redactor.js';

const known = (...values: string[]) => new Redactor({ values: () => values });

describe('Redactor', () => {
  describe('known secrets', () => {
    const secret = 'correct-horse-battery-staple-42';
    const r = known(secret);

    it('masks the raw value', () => {
      const out = r.redactString(`using ${secret} now`);
      expect(out.value).toBe(`using ${KNOWN_SECRET_MASK} now`);
      expect(out.findings).toEqual([{ detector: 'known-secret' }]);
    });

    it('masks base64 and url-encoded variants', () => {
      const b64 = Buffer.from(secret).toString('base64');
      const weird = 'p@ss w0rd/with+chars&more';
      const r2 = known(weird);
      expect(r.redactString(`x ${b64} y`).value).not.toContain(b64);
      expect(r2.redactString(`q=${encodeURIComponent(weird)}`).value).not.toContain(
        encodeURIComponent(weird),
      );
    });

    it('ignores trivially short secrets to avoid masking everything', () => {
      expect(known('ab').redactString('ab cd').value).toBe('ab cd');
    });
  });

  describe('patterns', () => {
    const r = new Redactor();
    const cases: [string, string][] = [
      ['anthropic-key', 'key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'],
      ['github-token', 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
      ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
      ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
      ['url-credentials', 'git clone https://deploy:s3cr3tPassw0rd@github.com/acme/app.git'],
      ['assignment', 'password=hunter2xyz'],
      ['assignment', '"api_key": "abcd1234efgh"'],
      ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'],
      ['high-entropy', 'blob Zx8kQ2mN7pL4vR9tY3wB6cF1hJ5gD0sA here'],
      ['high-entropy', 'key Zx8kQ2mN7pL4vR9tY3wB6c/F1hJ5gD0sAx9Pq here'],
    ];
    it.each(cases)('detects %s', (detector, input) => {
      const out = r.redactString(input);
      expect(out.findings.map((f) => f.detector)).toContain(detector);
      expect(out.value).toContain(`[REDACTED:`);
    });

    it('keeps the surrounding text of a url credential', () => {
      expect(r.redactString('https://deploy:s3cr3tPassw0rd@github.com/x').value).toBe(
        'https://deploy:[REDACTED:url-credentials]@github.com/x',
      );
    });

    it('leaves ordinary content alone', () => {
      const benign = [
        'Implemented rate limiting on /api/login; see commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
        'Task 3f2b8c1e-4d5a-4f6b-9c7d-1e2f3a4b5c6d is done',
        'Used credential payments-repo-token to push branch orbot/task-12',
        'The secretName field references the store by name',
        '/tmp/orbot-test-ws-pGQW0L/repos/03187de6-a474-45db-a19e-7ce53b1d7bfe',
        '/home/orbot/orbot/workspaces/tasks/task-101/src/middleware/rateLimiter.ts',
        'https://github.com/acme/payments-service/pull/1423/files',
      ];
      for (const s of benign) expect(r.redactString(s).value).toBe(s);
    });
  });

  describe('redactDeep', () => {
    it('walks objects and arrays and masks secret-named fields', () => {
      const r = known('topsecretvalue');
      const out = r.redactDeep({
        a: ['ok', 'has topsecretvalue inside'],
        nested: { password: 'anything', secretName: 'payments-token' },
      });
      expect(out.value).toEqual({
        a: ['ok', `has ${KNOWN_SECRET_MASK} inside`],
        nested: { password: '[REDACTED:field]', secretName: 'payments-token' },
      });
      expect(out.findings.length).toBe(2);
    });

    it('redacts error messages and stacks', () => {
      const r = known('topsecretvalue');
      const err = new Error('failed with topsecretvalue');
      const out = r.redactDeep(err);
      expect(out.value.message).toBe(`failed with ${KNOWN_SECRET_MASK}`);
      expect(out.value.stack).not.toContain('topsecretvalue');
    });

    it('handles cycles', () => {
      const a: Record<string, unknown> = { x: 'y' };
      a['self'] = a;
      expect(() => new Redactor().redactDeep(a)).not.toThrow();
    });
  });
});
