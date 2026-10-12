import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Run git with a fixed identity and no interactive prompts. */
export async function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'ORBOT',
        GIT_AUTHOR_EMAIL: 'orbot@localhost',
        GIT_COMMITTER_NAME: 'ORBOT',
        GIT_COMMITTER_EMAIL: 'orbot@localhost',
        ...env,
      },
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`, e.stderr ?? '');
  }
}
