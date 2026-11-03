import {
  BadRequestException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  CreateTaskRequest,
  type BotEvent,
  type ConnectionSupply,
  type ConnectServiceRequest,
  type ConnectionView,
  type IssueView,
  type PolicyRule,
  type RecordEvent,
  type RecordVersion,
  type SupplyBody,
} from '@orbot/shared';
import type { Subscription } from 'rxjs';
import type { z } from 'zod';
import { Background } from '../common/background.js';
import { git } from '../common/git.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { toView } from '../domain/view.js';
import { WorkService } from '../domain/work.service.js';
import { TaskRunner } from '../execution/task-runner.js';
import { OFFICER_SECRET_PREFIX } from '../officers/officers.service.js';
import { OverseerService } from '../overseer/overseer.service.js';
import { HQ_ACTOR } from '../overseer/overseers.js';
import { PolicyService } from '../policy/policy.service.js';
import { RecordBus } from '../record/record-bus.js';
import { RecordService } from '../record/record.service.js';
import { RedactionService } from '../redaction/redaction.service.js';
import { WorkspaceManager } from '../runtime/workspace-manager.js';
import { SecretsService } from '../secrets/secrets.service.js';
import type { Connector } from './connector.js';
import { GitHubConnector } from './github.connector.js';

/** Status reason on production deploys held until the build pipeline is green. */
export const PIPELINE_HELD = 'The build pipeline is not green';

type Service = keyof ConnectionSupply['services'];
type Conn = RecordVersion<SupplyBody> & { spec: ConnectionSupply };

/**
 * Connections to the outside services a repository lives with:
 * - **code host**: an operation's integration branch is pushed after each integration, and a
 *   pull request opened for it; a finished task can be pushed and opened as one too;
 * - **build pipeline**: its result for each pushed commit is recorded; a failure sends a fix
 *   task to the building unit, and production deploys are held until the pipeline is green;
 * - **issue tracker**: open issues can be taken on as missions, and are commented on and
 *   closed when the mission is done.
 * Tokens are credentials used by name; nothing a service returns is trusted unredacted.
 */
@Injectable()
export class ConnectionsService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private sub: Subscription | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly record: RecordService,
    private readonly bus: RecordBus,
    private readonly background: Background,
    private readonly secrets: SecretsService,
    private readonly redaction: RedactionService,
    private readonly policy: PolicyService,
    private readonly runner: TaskRunner,
    private readonly overseer: OverseerService,
    private readonly work: WorkService,
    private readonly workspaces: WorkspaceManager,
  ) {}

  onModuleInit() {
    this.policy.addRule(this.deployGate());
  }

  onApplicationBootstrap(): void {
    this.sub = this.bus.notifications$.subscribe((n) => {
      if (n.type === 'event' && n.event.kind === 'integration' && n.event.operationId) {
        const opId = n.event.operationId;
        this.background.run(`connections:${opId}`, 'publish', () => this.publishOperation(opId));
      } else if (n.type === 'version' && n.version.entityType === 'mission') {
        const b = n.version.body as { status?: string; issue?: unknown };
        const id = n.version.entityId;
        if (b.status === 'done' && b.issue) {
          this.background.run(`connections:issue`, 'close-issue', () => this.closeIssue(id));
        }
      }
    });
    if (this.config.connectionsPollMs > 0) {
      this.timer = setInterval(
        () => this.background.run('connections:poll', 'poll', () => this.pollPipelines()),
        this.config.connectionsPollMs,
      );
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
  }

  // ---------- Connecting ----------

  async connect(input: z.output<typeof ConnectServiceRequest>, actor: string) {
    const repo = await this.record.requireActive('supply', input.repoSupplyId);
    if (repo.body.spec.kind !== 'repository') {
      throw new BadRequestException('Choose one of the depot’s repositories.');
    }
    if (/:\/\/[^/@\s]+:[^/@\s]+@/.test(input.pushUrl)) {
      throw new BadRequestException({
        message: 'That push URL contains a password or token.',
        action: 'Remove it, and store the token as a credential instead.',
      });
    }
    if (input.credentialName) {
      const known = (await this.secrets.list()).some(
        (s) => s.name === input.credentialName && !s.revoked,
      );
      if (!known || input.credentialName.startsWith(OFFICER_SECRET_PREFIX)) {
        throw new BadRequestException({
          message: `No credential named “${input.credentialName}” is stored.`,
          action: 'Store the token in the Supply Depot first.',
        });
      }
    }
    const spec: ConnectionSupply = {
      kind: 'connection',
      provider: input.provider,
      apiUrl: input.apiUrl,
      owner: input.owner,
      repo: input.repo,
      pushUrl: input.pushUrl,
      repoSupplyId: input.repoSupplyId,
      credentialName: input.credentialName,
      services: input.services,
      closeIssues: input.closeIssues,
    };
    try {
      await this.connector(spec).verify();
    } catch (err) {
      throw new BadRequestException({
        message: `Could not reach ${input.owner}/${input.repo}: ${this.redaction.clean((err as Error).message)}`,
        action: 'Check the API URL, the owner and repository names, and the token.',
      });
    }
    return this.record.create(
      'supply',
      { name: input.name, connected: true, spec },
      { actor, reason: `Connected ${input.provider} ${input.owner}/${input.repo}` },
    );
  }

  /** Disconnect: a new version, connected no longer. Its history stays on the record. */
  async disconnect(id: string, actor: string) {
    const s = await this.record.requireActive('supply', id);
    if (s.body.spec.kind !== 'connection')
      throw new BadRequestException('That is not a connection.');
    return this.record.revise('supply', id, (b) => ({ ...b, connected: false }), {
      actor,
      reason: 'Disconnected',
    });
  }

  async connections(): Promise<Conn[]> {
    return (await this.record.listActive('supply'))
      .filter((s) => s.body.spec.kind === 'connection' && s.body.connected)
      .map((s) => Object.assign(s, { spec: s.body.spec as ConnectionSupply }));
  }

  private async forRepo(repoSupplyId: string | null, service: Service): Promise<Conn | null> {
    if (!repoSupplyId) return null;
    return (
      (await this.connections()).find(
        (c) => c.spec.repoSupplyId === repoSupplyId && c.spec.services[service],
      ) ?? null
    );
  }

  private connector(spec: ConnectionSupply): Connector {
    return new GitHubConnector({
      apiUrl: spec.apiUrl,
      owner: spec.owner,
      repo: spec.repo,
      token: async () => (spec.credentialName ? this.secrets.reveal(spec.credentialName) : null),
    });
  }

  async view(): Promise<ConnectionView[]> {
    // Newest first.
    const recent = async (
      kind: 'connection.pr' | 'pipeline.status' | 'connection.error',
      limit: number,
    ) => (await this.record.listEvents({ kinds: [kind], limit }, { latest: true })).reverse();
    const [conns, prs, pipes, errors] = await Promise.all([
      this.connections(),
      recent('connection.pr', 500),
      recent('pipeline.status', 1000),
      recent('connection.error', 50),
    ]);
    const out: ConnectionView[] = [];
    for (const c of conns) {
      const repo = await this.record.getActive('supply', c.spec.repoSupplyId);
      const mine = <E extends RecordEvent>(es: E[]) =>
        es.filter((e) => (e.body as { connectionId: string }).connectionId === c.entityId);
      const latestPerBranch = new Map<string, RecordEvent<'pipeline.status'>>();
      for (const p of mine(pipes) as RecordEvent<'pipeline.status'>[]) {
        if (!latestPerBranch.has(p.body.branch)) latestPerBranch.set(p.body.branch, p);
      }
      out.push({
        supply: toView(c),
        repositoryName: repo?.body.name ?? '',
        pullRequests: mine(prs) as RecordEvent<'connection.pr'>[],
        pipelines: [...latestPerBranch.values()],
        errors: (mine(errors) as RecordEvent<'connection.error'>[]).slice(0, 5),
      });
    }
    return out;
  }

  private async failed(
    conn: Conn,
    what: string,
    err: unknown,
    refs: { operationId?: string | null; taskId?: string | null } = {},
  ) {
    await this.record.event(
      'connection.error',
      {
        connectionId: conn.entityId,
        what,
        error: this.redaction.clean((err as Error).message ?? String(err)),
      },
      refs,
      HQ_ACTOR,
    );
  }

  // ---------- Code host ----------

  /** Push a branch to the code host. The token goes in the environment, never in a URL or argument. */
  private async push(conn: Conn, repo: SupplyBody, branch: string): Promise<string> {
    if (repo.spec.kind !== 'repository') throw new Error('Not a repository.');
    const env: Record<string, string> = {};
    if (conn.spec.credentialName && /^https?:/.test(conn.spec.pushUrl)) {
      const token = await this.secrets.reveal(conn.spec.credentialName);
      env['GIT_CONFIG_COUNT'] = '1';
      env['GIT_CONFIG_KEY_0'] = 'http.extraHeader';
      env['GIT_CONFIG_VALUE_0'] =
        `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }
    await git(
      repo.spec.localPath,
      ['push', '--quiet', conn.spec.pushUrl, `${branch}:refs/heads/${branch}`],
      env,
    );
    return git(repo.spec.localPath, ['rev-parse', branch]);
  }

  /** After an integration: push the operation's branch, open its pull request once, watch the pipeline. */
  async publishOperation(opId: string): Promise<void> {
    const op = await this.record.getActive('operation', opId);
    if (!op?.body.integrationBranch || !op.body.repoSupplyId) return;
    const conn = await this.forRepo(op.body.repoSupplyId, 'codeHost');
    if (!conn) return;
    const repo = await this.record.requireActive('supply', op.body.repoSupplyId);
    const branch = op.body.integrationBranch;
    try {
      const sha = await this.push(conn, repo.body, branch);
      if (!op.body.pullRequest) {
        const c = this.connector(conn.spec);
        const base = repo.body.spec.kind === 'repository' ? repo.body.spec.defaultBranch : 'main';
        const pr =
          (await c.findPullRequest(branch)) ??
          (await c.openPullRequest({
            head: branch,
            base,
            title: `Operation ${op.body.name}`,
            body: `${op.body.intent}\n\nOpened by ORBOT HQ. Every unit's work lands on \`${branch}\` before it ships.`,
          }));
        const ref = { connectionId: conn.entityId, number: pr.number, url: pr.url, branch };
        await this.record.transaction(async (w) => {
          await w.revise('operation', opId, (o) => ({ ...o, pullRequest: ref }), {
            actor: HQ_ACTOR,
            reason: `Pull request #${pr.number} opened`,
          });
          await w.event('connection.pr', { ...ref, base }, { operationId: opId }, HQ_ACTOR);
          await w.event(
            'sitrep',
            {
              level: 'hq',
              text: `HQ opened pull request #${pr.number} for Operation ${op.body.name} (${branch}).`,
              status: null,
            },
            { operationId: opId },
            HQ_ACTOR,
          );
        });
      }
      await this.watch(op.body.repoSupplyId, branch, sha, { operationId: opId });
    } catch (err) {
      await this.failed(conn, `publish ${branch}`, err, { operationId: opId });
    }
  }

  /** Push a finished task's branch and open a pull request for it. */
  async publishTask(taskId: string, actor: string) {
    const task = await this.record.requireActive('task', taskId);
    const conn = await this.forRepo(task.body.repoSupplyId, 'codeHost');
    if (!conn) {
      throw new BadRequestException({
        message: 'No code host is connected for this task’s repository.',
        action: 'Connect one in the Supply Depot.',
      });
    }
    if (!task.body.workspace) {
      throw new BadRequestException({
        message: `Task #${task.body.number} has no branch yet.`,
        action: 'Run the task first.',
      });
    }
    if (task.body.pullRequest) return task;
    const repo = await this.record.requireActive('supply', task.body.repoSupplyId!);
    const branch = task.body.workspace.branch;
    try {
      const sha = await this.push(conn, repo.body, branch);
      const c = this.connector(conn.spec);
      const base =
        task.body.baseRef ??
        (repo.body.spec.kind === 'repository' ? repo.body.spec.defaultBranch : 'main');
      const pr =
        (await c.findPullRequest(branch)) ??
        (await c.openPullRequest({
          head: branch,
          base,
          title: `Task #${task.body.number}: ${task.body.title}`,
          body: `${task.body.description || task.body.title}\n\nOpened by ORBOT.`,
        }));
      const ref = { connectionId: conn.entityId, number: pr.number, url: pr.url, branch };
      const refs = { unitId: task.body.unitId, taskId, botId: task.body.botId };
      const saved = await this.record.transaction(async (w) => {
        const v = await w.revise('task', taskId, (t) => ({ ...t, pullRequest: ref }), {
          actor,
          reason: `Pull request #${pr.number} opened`,
        });
        await w.event('connection.pr', { ...ref, base }, refs, actor);
        return v;
      });
      await this.watch(task.body.repoSupplyId!, branch, sha, refs);
      return saved;
    } catch (err) {
      await this.failed(conn, `publish ${branch}`, err, { taskId });
      throw new BadRequestException({
        message: `Could not open a pull request: ${this.redaction.clean((err as Error).message)}`,
        action: 'Check the connection in the Supply Depot.',
      });
    }
  }

  // ---------- Build pipeline ----------

  /** Start watching the pipeline for a pushed commit. */
  private async watch(
    repoSupplyId: string,
    branch: string,
    sha: string,
    refs: { operationId?: string | null; unitId?: string | null; taskId?: string | null },
  ) {
    const conn = await this.forRepo(repoSupplyId, 'pipeline');
    if (!conn) return;
    const latest = await this.latestStatus(conn.entityId, branch);
    if (latest?.body.sha === sha) return;
    await this.record.event(
      'pipeline.status',
      { connectionId: conn.entityId, branch, sha, state: 'pending', url: null },
      refs,
      HQ_ACTOR,
    );
    await this.pollOne(conn, branch);
  }

  private async latestStatus(connectionId: string, branch: string) {
    const [e] = await this.record.findEvents(
      ['pipeline.status'],
      { connectionId, branch },
      { limit: 1, latest: true },
    );
    return (e as RecordEvent<'pipeline.status'> | undefined) ?? null;
  }

  /** Check every pipeline still pending. */
  async pollPipelines(): Promise<void> {
    for (const conn of (await this.connections()).filter((c) => c.spec.services.pipeline)) {
      const pending = (
        (await this.record.findEvents(
          ['pipeline.status'],
          { connectionId: conn.entityId, state: 'pending' },
          { limit: 200 },
        )) as RecordEvent<'pipeline.status'>[]
      ).map((e) => e.body.branch);
      for (const branch of new Set(pending)) await this.pollOne(conn, branch);
    }
  }

  private async pollOne(conn: Conn, branch: string) {
    const latest = await this.latestStatus(conn.entityId, branch);
    if (!latest || latest.body.state !== 'pending') return;
    let result;
    try {
      result = await this.connector(conn.spec).pipeline(latest.body.sha);
    } catch (err) {
      await this.failed(conn, `pipeline ${branch}`, err, { operationId: latest.operationId });
      return;
    }
    if (result.state === 'pending' || result.state === 'none') return;
    const refs = { operationId: latest.operationId, unitId: latest.unitId, taskId: latest.taskId };
    await this.record.event(
      'pipeline.status',
      {
        connectionId: conn.entityId,
        branch,
        sha: latest.body.sha,
        state: result.state,
        url: result.url,
      },
      refs,
      HQ_ACTOR,
    );
    if (latest.operationId) {
      if (result.state === 'success') await this.releaseDeploys(latest.operationId);
      else await this.sendFix(latest.operationId, branch, latest.body.sha, result.url);
    }
  }

  /** The pipeline failed on an operation's branch: the building unit gets a fix task. */
  private async sendFix(opId: string, branch: string, sha: string, url: string | null) {
    const op = await this.record.requireActive('operation', opId);
    const missions = await Promise.all(
      op.body.missionIds.map((id) => this.record.getActive('mission', id)),
    );
    const build = missions.find((m) => m?.body.stage === 'build') ?? missions[0];
    if (!build) return;
    const bots = (await this.record.listActive('bot', { unitId: build.body.unitId })).filter(
      (b) => !b.body.isOverseer && b.body.status !== 'stood-down' && !b.body.halt,
    );
    const free = (b: (typeof bots)[number]) => (b.body.status === 'idle' ? 0 : 1);
    const bot = bots.sort(
      (a, b) => free(a) - free(b) || a.body.queue.length - b.body.queue.length,
    )[0];
    const number = await this.record.nextTaskNumber();
    const reason = `The build pipeline fails on ${branch} at ${sha.slice(0, 10)}${url ? ` (${url})` : ''}`;
    await this.record.transaction(async (w) => {
      if (build.body.status === 'done') {
        await w.revise('mission', build.entityId, (m) => ({ ...m, status: 'working' }), {
          actor: HQ_ACTOR,
          reason,
        });
      }
      await this.work.writeTask(
        w,
        number,
        {
          ...CreateTaskRequest.parse({
            unitId: build.body.unitId,
            botId: bot?.entityId ?? null,
            missionId: build.entityId,
            title: `Fix: the build pipeline fails on ${branch}`,
            description: reason,
            repoSupplyId: op.body.repoSupplyId,
            scenario: 'fix',
          }),
          kind: 'fix',
          autoStart: true,
          baseRef: branch,
        },
        { actor: HQ_ACTOR, reason },
      );
      await w.event(
        'sitrep',
        {
          level: 'hq',
          text: `${reason}. Task #${number} sent to fix it; production deploys wait for green.`,
          status: null,
        },
        { operationId: opId, unitId: build.body.unitId },
        HQ_ACTOR,
      );
    });
  }

  /** Green again: production deploys held for the pipeline go ahead. */
  private async releaseDeploys(opId: string) {
    const op = await this.record.requireActive('operation', opId);
    const tasks = (await this.record.listActive('task')).filter(
      (t) =>
        t.body.missionId &&
        op.body.missionIds.includes(t.body.missionId) &&
        t.body.status === 'blocked' &&
        t.body.statusReason?.includes(PIPELINE_HELD),
    );
    for (const t of tasks) await this.runner.resume(t.entityId, HQ_ACTOR).catch(() => undefined);
  }

  /** Nothing ships while the pipeline is red (or still running) on what is being deployed. */
  private deployGate(): PolicyRule {
    return {
      name: 'Pipeline',
      evaluate: async (req) => {
        if (req.action !== 'bot.artifact' || !req.taskId) return null;
        const ev = (req.details as { event?: BotEvent } | undefined)?.event;
        if (ev?.type !== 'artifact' || ev.kind !== 'deployment') return null;
        const task = await this.record.getActive('task', req.taskId);
        const mission = task?.body.missionId
          ? await this.record.getActive('mission', task.body.missionId)
          : null;
        const op = mission?.body.operationId
          ? await this.record.getActive('operation', mission.body.operationId)
          : null;
        if (!op?.body.integrationBranch) return null;
        const conn = await this.forRepo(op.body.repoSupplyId, 'pipeline');
        if (!conn) return null;
        const branch = op.body.integrationBranch;
        const latest = await this.latestStatus(conn.entityId, branch);
        const repo = await this.record.requireActive('supply', op.body.repoSupplyId!);
        const head = await this.workspaces.head(repo.body, branch);
        const state = !latest
          ? 'not run'
          : latest.body.sha !== head
            ? 'not run on the latest commit'
            : latest.body.state;
        if (state === 'success') return null;
        return {
          allowed: false,
          reason: `${PIPELINE_HELD}: ${state} on ${branch}`,
          action: 'The deploy goes ahead by itself once the pipeline passes.',
        };
      },
    };
  }

  // ---------- Issue tracker ----------

  async issues(connectionId: string): Promise<IssueView[]> {
    const conn = (await this.connections()).find(
      (c) => c.entityId === connectionId && c.spec.services.issues,
    );
    if (!conn) throw new BadRequestException('No issue tracker is connected with that id.');
    const [open, missions, units] = await Promise.all([
      this.connector(conn.spec).openIssues(),
      this.record.listActive('mission'),
      this.record.listActive('unit'),
    ]);
    return open.map((i) => {
      const m = missions.find(
        (x) => x.body.issue?.connectionId === connectionId && x.body.issue.number === i.number,
      );
      return {
        number: i.number,
        title: this.redaction.clean(i.title),
        url: i.url,
        labels: i.labels,
        taken: m
          ? {
              missionId: m.entityId,
              unitId: m.body.unitId,
              unitName: units.find((u) => u.entityId === m.body.unitId)?.body.name ?? '',
            }
          : null,
      };
    });
  }

  /** Take an issue on as a mission: its title is the goal, its checklist the definition of done. */
  async takeIssue(connectionId: string, unitId: string, number: number, actor: string) {
    const conn = (await this.connections()).find(
      (c) => c.entityId === connectionId && c.spec.services.issues,
    );
    if (!conn) throw new BadRequestException('No issue tracker is connected with that id.');
    const issue = (await this.connector(conn.spec).openIssues()).find((i) => i.number === number);
    if (!issue) {
      throw new BadRequestException({
        message: `Issue #${number} is not open on ${conn.spec.owner}/${conn.spec.repo}.`,
        action: 'Pick an open issue.',
      });
    }
    const already = (await this.record.listActive('mission')).find(
      (m) => m.body.issue?.connectionId === connectionId && m.body.issue.number === number,
    );
    if (already) {
      throw new BadRequestException({
        message: `Issue #${number} is already taken on.`,
        action: 'See the mission it became.',
      });
    }
    const title = this.redaction.clean(issue.title);
    const checklist = this.redaction
      .clean(issue.body)
      .split('\n')
      .map((l) => /^\s*[-*]\s*\[[ xX]?\]\s*(.+)$/.exec(l)?.[1]?.trim())
      .filter((x): x is string => !!x);
    const mission = await this.overseer.createMission(
      {
        unitId,
        goal: `${title} (issue #${number})`.slice(0, 500),
        definitionOfDone: checklist.length ? checklist : [`Issue #${number} is resolved`],
      },
      actor,
      { preApproved: true },
    );
    const ref = { connectionId, number, url: issue.url, title };
    return this.record.transaction(async (w) => {
      const taken = await w.revise('mission', mission.entityId, (m) => ({ ...m, issue: ref }), {
        actor,
        reason: `Took on issue #${number}`,
      });
      await w.event(
        'issue.taken',
        { ...ref, missionId: mission.entityId },
        { unitId, missionId: mission.entityId },
        actor,
      );
      return taken;
    });
  }

  /** The mission that took an issue on is done: say so on the issue, and close it. */
  private async closeIssue(missionId: string) {
    const m = await this.record.getActive('mission', missionId);
    const ref = m?.body.issue;
    if (!m || !ref) return;
    const conn = (await this.connections()).find((c) => c.entityId === ref.connectionId);
    if (!conn?.spec.closeIssues) return;
    const [done] = await this.record.findEvents(
      ['issue.closed'],
      { connectionId: ref.connectionId, number: ref.number },
      { limit: 1 },
    );
    if (done) return;
    const unit = await this.record.getActive('unit', m.body.unitId);
    const op = m.body.operationId
      ? await this.record.getActive('operation', m.body.operationId)
      : null;
    const comment = this.redaction.clean(
      `Done by ${unit?.body.name ?? 'the unit'} (mission “${m.body.goal}”): ${m.body.definitionOfDone.join('; ')}.${
        op?.body.pullRequest ? ` Pull request: ${op.body.pullRequest.url}` : ''
      }`,
    );
    try {
      const c = this.connector(conn.spec);
      await c.comment(ref.number, comment);
      await c.closeIssue(ref.number);
      await this.record.event(
        'issue.closed',
        { connectionId: ref.connectionId, number: ref.number, comment },
        { unitId: m.body.unitId, missionId },
        HQ_ACTOR,
      );
    } catch (err) {
      await this.failed(conn, `close issue #${ref.number}`, err);
    }
  }
}
