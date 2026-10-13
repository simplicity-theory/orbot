/** What ORBOT needs from a code host, issue tracker and build pipeline. One adapter per provider. */
export interface Connector {
  /** Check the connection works (the repository is reachable with the token). */
  verify(): Promise<{ defaultBranch: string }>;
  openPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
  /** The open pull request for a branch, if there is one. */
  findPullRequest(head: string): Promise<{ number: number; url: string } | null>;
  openIssues(): Promise<
    { number: number; title: string; body: string; url: string; labels: string[] }[]
  >;
  comment(issue: number, text: string): Promise<void>;
  closeIssue(issue: number): Promise<void>;
  /** The pipeline's result for a commit: success, failure, pending, or none (no checks yet). */
  pipeline(
    sha: string,
  ): Promise<{ state: 'success' | 'failure' | 'pending' | 'none'; url: string | null }>;
}

export class ConnectorError extends Error {}
