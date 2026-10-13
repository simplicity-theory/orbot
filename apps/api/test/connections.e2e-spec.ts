import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConnectionView,
  IssueView,
  OperationDetailView,
  RecordEvent,
  TaskDetailView,
  UnitDetailView,
} from '@orbot/shared';
import { git } from '../src/common/git.js';
import { makeRepo, makeUnitWithBot, settled, waitFor } from './fixtures.js';
import { startTestApp, type TestApp } from './helpers.js';

const TOKEN = 'ghp_fake_token_for_connections_0123456789';

/** A small stand-in for the GitHub REST API: pulls, issues, check runs. */
class FakeGitHub {
  server!: Server;
  url = '';
  pulls: { number: number; head: string; base: string; title: string }[] = [];
  comments: { issue: number; body: string }[] = [];
  closed: number[] = [];
  /** Check-run result per commit sha; anything else is still running. */
  checks = new Map<string, 'success' | 'failure'>();
  issues = [
    {
      number: 7,
      title: 'Login is slow',
      body: 'Users wait too long.\n\n- [ ] p95 under 200 ms\n- [ ] Cache the user lookup',
      html_url: 'https://github.example/acme/app/issues/7',
      labels: [{ name: 'perf' }],
    },
  ];
  unauthorised = 0;

  async start() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const send = (code: number, body: unknown) =>
          res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          this.unauthorised++;
          return send(401, { message: 'Bad credentials' });
        }
        const url = new URL(req.url ?? '/', 'http://x');
        const p = url.pathname.replace(/^\/repos\/acme\/app/, '');
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === 'GET' && p === '') return send(200, { default_branch: 'main' });
        if (req.method === 'GET' && p === '/pulls') {
          const head = (url.searchParams.get('head') ?? '').replace(/^acme:/, '');
          return send(
            200,
            this.pulls
              .filter((x) => x.head === head)
              .map((x) => ({
                number: x.number,
                html_url: `https://github.example/pr/${x.number}`,
              })),
          );
        }
        if (req.method === 'POST' && p === '/pulls') {
          const pr = { number: 100 + this.pulls.length, ...body };
          this.pulls.push(pr);
          return send(201, {
            number: pr.number,
            html_url: `https://github.example/pr/${pr.number}`,
          });
        }
        if (req.method === 'GET' && p === '/issues')
          return send(
            200,
            this.issues.filter((i) => !this.closed.includes(i.number)),
          );
        const c = /^\/issues\/(\d+)\/comments$/.exec(p);
        if (req.method === 'POST' && c) {
          this.comments.push({ issue: Number(c[1]), body: body.body });
          return send(201, {});
        }
        const i = /^\/issues\/(\d+)$/.exec(p);
        if (req.method === 'PATCH' && i) {
          this.closed.push(Number(i[1]));
          return send(200, {});
        }
        const k = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(p);
        if (req.method === 'GET' && k) {
          const r = this.checks.get(k[1]!);
          return send(200, {
            check_runs: [
              {
                status: r ? 'completed' : 'in_progress',
                conclusion: r ?? null,
                html_url: `https://github.example/runs/${k[1]!.slice(0, 7)}`,
              },
            ],
          });
        }
        return send(404, { message: 'Not Found' });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

/**
 * Phase 5, Connections: the code host, issue tracker and build pipeline for a repository.
 * Work is pushed and opened as pull requests; a red pipeline sends a fix and holds the
 * production deploy until it is green; issues become missions and are closed when done.
 */
describe('Connections', () => {
  let t: TestApp;
  const gh = new FakeGitHub();
  let remote: string;
  let repoId: string;
  let engId: string;
  let logId: string;
  let connId: string;

  const connections = async (): Promise<ConnectionView[]> =>
    (await t.agent.get('/api/connections').expect(200)).body;
  const op = async (id: string): Promise<OperationDetailView> =>
    (await t.agent.get(`/api/operations/${id}`).expect(200)).body;
  const remoteHead = (branch: string) => git(remote, ['rev-parse', branch]).catch(() => null);

  beforeAll(async () => {
    await gh.start();
    remote = mkdtempSync(join(tmpdir(), 'orbot-remote-'));
    await git(remote, ['init', '--quiet', '--bare', '-b', 'main']);
    t = await startTestApp();
    repoId = (
      await t.agent
        .post('/api/supply/repositories')
        .send({ name: 'app', location: await makeRepo() })
        .expect(201)
    ).body.id;
    await t.agent
      .post('/api/supply/credentials')
      .send({ name: 'gh-token', value: TOKEN })
      .expect(201);
    engId = (
      await makeUnitWithBot(t.app, { supplyIds: [repoId], gate: 'escalations-only', bots: 2 })
    ).unit.entityId;
    logId = (
      await makeUnitWithBot(t.app, {
        name: 'Logistics',
        prefix: 'L',
        role: 'DevOps',
        gate: 'escalations-only',
        supplyIds: [repoId],
      })
    ).unit.entityId;
    const prod = (
      await t.agent
        .post('/api/supply/environments')
        .send({ name: 'production', tier: 'production' })
        .expect(201)
    ).body.id;
    await t.agent.post('/api/supply/allot').send({ supplyId: prod, unitId: logId }).expect(200);
  });
  afterAll(async () => {
    await t.close();
    gh.server.close();
  });

  it('connects GitHub for a repository, checking it can reach it; never with a token in a URL', async () => {
    const base = {
      name: 'GitHub acme/app',
      apiUrl: gh.url,
      owner: 'acme',
      repo: 'app',
      pushUrl: remote,
      repoSupplyId: repoId,
      services: { codeHost: true, issues: true, pipeline: true },
    };
    await t.agent
      .post('/api/supply/connections')
      .send({ ...base, credentialName: null })
      .expect(400)
      .expect((r) => expect(r.body.error.message).toContain('GitHub answered 401'));
    await t.agent
      .post('/api/supply/connections')
      .send({
        ...base,
        credentialName: 'gh-token',
        pushUrl: `https://bot:${TOKEN}@github.example/acme/app.git`,
      })
      .expect(400);
    connId = (
      await t.agent
        .post('/api/supply/connections')
        .send({ ...base, credentialName: 'gh-token' })
        .expect(201)
    ).body.id;
    const [c] = await connections();
    expect(c).toMatchObject({ repositoryName: 'app', supply: { id: connId, connected: true } });
  });

  let opId: string;
  let firstSha: string;

  it('an operation’s integration branch is pushed and opened as a pull request; a red pipeline sends a fix', async () => {
    opId = (
      await t.agent
        .post('/api/operations')
        .send({ intent: 'Rate limit the login endpoint.', name: 'Throttle' })
        .expect(201)
    ).body.id;
    const v = await waitFor(async () => {
      const x = await op(opId);
      return x.operation.pullRequest ? x : null;
    });
    const branch = v.operation.integrationBranch!;
    expect(v.operation.pullRequest).toMatchObject({
      connectionId: connId,
      number: 100,
      url: 'https://github.example/pr/100',
      branch,
    });
    expect(gh.pulls[0]).toMatchObject({ head: branch, base: 'main', title: 'Operation Throttle' });
    firstSha = (await remoteHead(branch))!;
    expect(firstSha).toMatch(/^[0-9a-f]{40}$/);

    // The pipeline fails on that commit: the building unit gets a fix task.
    gh.checks.set(firstSha, 'failure');
    await t.agent.post('/api/connections/poll').expect(204);
    const fix = await waitFor(async () => {
      const unit: UnitDetailView = (await t.agent.get(`/api/units/${engId}`).expect(200)).body;
      return (
        unit.tasks.find((x) => x.title === `Fix: the build pipeline fails on ${branch}`) ?? null
      );
    });
    expect(fix.description).toContain(`at ${firstSha.slice(0, 10)} (https://github.example/runs/`);
    // Only one pull request, however many pushes.
    await waitFor(async () => ((await remoteHead(branch)) !== firstSha ? true : null));
    expect(gh.pulls).toHaveLength(1);
  });

  it('the production deploy is held until the pipeline is green, then goes ahead by itself', async () => {
    // Logistics (escalations only) deploys without asking; the pipeline holds it.
    const branch = (await op(opId)).operation.integrationBranch!;
    const held = await waitFor(async () => {
      const v = await op(opId);
      return (
        v.missions
          .flatMap((m) => m.tasks)
          .find((x) => x.kind === 'deploy' && x.status === 'blocked') ?? null
      );
    });
    expect(held.statusReason).toMatch(
      new RegExp(
        `^Held by policy: The build pipeline is not green: (failure|pending) on ${branch}$`,
      ),
    );
    const deploy = held;
    // The fix is pushed; its commit is still being checked.
    await settled(t.app);
    const head = (await remoteHead(branch))!;
    expect(head).not.toBe(firstSha);

    gh.checks.set(head, 'success');
    await t.agent.post('/api/connections/poll').expect(204);
    const done = await waitFor(async () => {
      const d: TaskDetailView = (await t.agent.get(`/api/tasks/${deploy.id}`).expect(200)).body;
      return d.task.status === 'done' ? d : null;
    });
    expect(done.events.some((e) => e.kind === 'deployment')).toBe(true);
    const [c] = await connections();
    expect(c!.pipelines.find((p) => p.body.branch === branch)?.body.state).toBe('success');
  });

  it('an issue is taken on as a mission, then commented on and closed when the mission is done', async () => {
    await settled(t.app);
    const issues: IssueView[] = (await t.agent.get(`/api/connections/${connId}/issues`).expect(200))
      .body;
    expect(issues).toEqual([
      {
        number: 7,
        title: 'Login is slow',
        url: 'https://github.example/acme/app/issues/7',
        labels: ['perf'],
        taken: null,
      },
    ]);
    const mission = (
      await t.agent
        .post(`/api/connections/${connId}/issues/take`)
        .send({ unitId: engId, number: 7 })
        .expect(201)
    ).body;
    expect(mission).toMatchObject({
      goal: 'Login is slow (issue #7)',
      definitionOfDone: ['p95 under 200 ms', 'Cache the user lookup'],
      issue: { connectionId: connId, number: 7 },
    });
    await t.agent
      .post(`/api/connections/${connId}/issues/take`)
      .send({ unitId: engId, number: 7 })
      .expect(400);
    await waitFor(async () => (gh.closed.includes(7) ? true : null));
    expect(gh.comments[0]).toMatchObject({ issue: 7 });
    expect(gh.comments[0]!.body).toMatch(
      /^Done by Engineers \(mission “Login is slow \(issue #7\)”\)/,
    );
  });

  it('chat takes an issue on, with Undo', async () => {
    gh.issues.push({
      number: 8,
      title: 'Logout leaves the session open',
      body: '',
      html_url: 'https://github.example/acme/app/issues/8',
      labels: [],
    });
    const r = (
      await t.agent.post(`/api/chat/${engId}`).send({ text: 'Take on issue #8.' }).expect(201)
    ).body;
    const item = r.readback.body.items[0];
    expect(item.summary).toBe(
      'Engineers takes on issue #8: new mission “Logout leaves the session open (issue #8)”. The Overseer will brief back a plan.',
    );
    expect(item.reversible).toBe(true);
    const issues: IssueView[] = (await t.agent.get(`/api/connections/${connId}/issues`).expect(200))
      .body;
    expect(issues.find((i) => i.number === 8)?.taken?.unitName).toBe('Engineers');
  });

  it('a finished task can be pushed and opened as a pull request', async () => {
    await settled(t.app);
    const unit: UnitDetailView = (await t.agent.get(`/api/units/${engId}`).expect(200)).body;
    const bot = unit.bots[0]!;
    const task = (
      await t.agent
        .post('/api/tasks')
        .send({ unitId: engId, botId: bot.id, title: 'Tidy the README', repoSupplyId: repoId })
        .expect(201)
    ).body;
    await t.agent.post(`/api/tasks/${task.id}/run`).expect(202);
    await settled(t.app);
    const after = (await t.agent.post(`/api/tasks/${task.id}/pull-request`).expect(200)).body;
    expect(after.pullRequest).toMatchObject({ branch: `orbot/task-${task.number}` });
    expect(await remoteHead(`orbot/task-${task.number}`)).toMatch(/^[0-9a-f]{40}$/);
    expect(gh.pulls.at(-1)).toMatchObject({ title: `Task #${task.number}: Tidy the README` });
  });

  it('the token is in no record and no response', async () => {
    const everything = JSON.stringify([
      await connections(),
      (await t.agent.get('/api/supply').expect(200)).body,
      (await t.agent.get('/api/record/events').query({ limit: 1000 }).expect(200)).body,
    ]);
    expect(everything).not.toContain(TOKEN);
    expect(gh.unauthorised).toBe(1); // only the attempt with no credential
    const errors = (
      (await t.agent.get('/api/record/events').query({ kinds: 'connection.error' }).expect(200))
        .body as RecordEvent<'connection.error'>[]
    ).map((e) => e.body.error);
    expect(errors).toEqual([]);
  });

  it('disconnecting keeps the history; the connection no longer acts', async () => {
    await t.agent.post(`/api/supply/connections/${connId}/disconnect`).expect(200);
    expect(await connections()).toEqual([]);
    const history = (await t.agent.get(`/api/record/${connId}/history`).expect(200)).body as {
      superseded: { reason: string } | null;
    }[];
    expect(history.map((v) => v.superseded?.reason ?? null)).toEqual(['Disconnected', null]);
  });
});
