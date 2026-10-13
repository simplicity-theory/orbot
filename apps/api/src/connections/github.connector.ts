import { ConnectorError, type Connector } from './connector.js';

interface GitHubOptions {
  apiUrl: string;
  owner: string;
  repo: string;
  /** Called for each request; the token never leaves this function. */
  token: () => Promise<string | null>;
}

/**
 * GitHub (or GitHub Enterprise) through its REST API: pull requests, issues, and check runs
 * (falling back to commit statuses) for the pipeline.
 */
export class GitHubConnector implements Connector {
  constructor(private readonly o: GitHubOptions) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.o.token();
    const url = `${this.o.apiUrl.replace(/\/$/, '')}/repos/${this.o.owner}/${this.o.repo}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ORBOT',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res
        .json()
        .then((j) => (j as { message?: string }).message ?? '')
        .catch(() => '');
      throw new ConnectorError(
        `GitHub answered ${res.status} for ${method} ${path}${detail ? `: ${detail}` : ''}.`,
      );
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  async verify() {
    const r = await this.call<{ default_branch: string }>('GET', '');
    return { defaultBranch: r.default_branch };
  }

  async openPullRequest(input: { head: string; base: string; title: string; body: string }) {
    const r = await this.call<{ number: number; html_url: string }>('POST', '/pulls', input);
    return { number: r.number, url: r.html_url };
  }

  async findPullRequest(head: string) {
    const list = await this.call<{ number: number; html_url: string }[]>(
      'GET',
      `/pulls?state=open&head=${encodeURIComponent(`${this.o.owner}:${head}`)}`,
    );
    return list[0] ? { number: list[0].number, url: list[0].html_url } : null;
  }

  async openIssues() {
    const list = await this.call<
      {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        labels: { name: string }[];
        pull_request?: unknown;
      }[]
    >('GET', '/issues?state=open&per_page=100');
    return list
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        url: i.html_url,
        labels: i.labels.map((l) => l.name),
      }));
  }

  async comment(issue: number, text: string) {
    await this.call('POST', `/issues/${issue}/comments`, { body: text });
  }

  async closeIssue(issue: number) {
    await this.call('PATCH', `/issues/${issue}`, { state: 'closed', state_reason: 'completed' });
  }

  async pipeline(sha: string) {
    const runs = await this.call<{
      check_runs: { status: string; conclusion: string | null; html_url: string }[];
    }>('GET', `/commits/${sha}/check-runs`);
    if (runs.check_runs.length) {
      const failed = runs.check_runs.find((r) =>
        ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion ?? ''),
      );
      if (failed) return { state: 'failure' as const, url: failed.html_url };
      const running = runs.check_runs.find((r) => r.status !== 'completed');
      if (running) return { state: 'pending' as const, url: running.html_url };
      return { state: 'success' as const, url: runs.check_runs[0]!.html_url };
    }
    const status = await this.call<{ state: string; statuses: { target_url: string | null }[] }>(
      'GET',
      `/commits/${sha}/status`,
    );
    if (!status.statuses.length) return { state: 'none' as const, url: null };
    const url = status.statuses[0]!.target_url;
    return {
      state:
        status.state === 'success'
          ? ('success' as const)
          : status.state === 'pending'
            ? ('pending' as const)
            : ('failure' as const),
      url,
    };
  }
}
