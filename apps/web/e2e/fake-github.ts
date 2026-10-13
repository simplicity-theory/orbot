import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A tiny stand-in for the GitHub REST API (issues, pulls, check runs) for UI tests. */
export class FakeGitHub {
  server!: Server;
  url = '';
  readonly token = 'ghp_ui_test_token_0123456789abcdef';
  /** A bare repository to push to. */
  readonly remote = mkdtempSync(join(tmpdir(), 'orbot-ui-remote-'));
  readonly issues = [
    {
      number: 42,
      title: 'Session cookie lacks SameSite',
      body: '- [ ] Set SameSite=Lax on the session cookie',
      html_url: 'https://github.example/acme/app/issues/42',
      labels: [{ name: 'security' }],
    },
  ];

  async start() {
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', this.remote]);
    this.server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const send = (code: number, body: unknown) =>
          res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        if (req.headers.authorization !== `Bearer ${this.token}`)
          return send(401, { message: 'Bad credentials' });
        const p = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/repos\/acme\/app/, '');
        if (p === '') return send(200, { default_branch: 'main' });
        if (p === '/issues') return send(200, this.issues);
        if (p === '/pulls') return send(200, []);
        return send(404, { message: 'Not Found' });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    this.server.close();
  }
}
