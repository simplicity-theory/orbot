import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  /** Pinned known_hosts lines: the only host keys ssh will accept. */
  hostKeys: string[];
}

export interface SshResult {
  exitCode: number | null;
  output: string;
}

const MAX_OUTPUT = 512 * 1024;

/**
 * Run a program; collect its output (capped), feed stdin, honour a timeout and an abort.
 * With `binary`, stdout is kept apart as bytes (stderr is the text output).
 */
function exec(
  cmd: string,
  args: string[],
  opts: {
    stdin?: Buffer | string;
    timeoutMs: number;
    signal?: AbortSignal;
    cwd?: string;
    binary?: boolean;
  },
): Promise<SshResult & { stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Nothing of ORBOT's environment: no agent, no keys, no passwords.
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    let out = '';
    const bytes: Buffer[] = [];
    const take = (b: Buffer) => {
      if (out.length < MAX_OUTPUT) out += b.toString('utf8');
    };
    if (opts.binary) child.stdout.on('data', (b: Buffer) => bytes.push(b));
    else child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      out += `\n[ORBOT: stopped after ${Math.round(opts.timeoutMs / 1000)} s]`;
      child.kill('SIGTERM');
    }, opts.timeoutMs);
    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, output: out, stdout: Buffer.concat(bytes) });
    });
    // A server that closes early (e.g. a failed login) must not crash ORBOT on EPIPE.
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.stdin ?? '');
  });
}

/**
 * The OpenSSH client, used the strict way: the key from a private temporary file (deleted
 * straight after), only the pinned host keys, no agent, no user ssh config, no prompts.
 * Tests replace `scan` and `run`.
 */
@Injectable()
export class SshClient {
  /** The host keys a server offers (known_hosts lines), for pinning when it is connected. */
  async scan(host: string, port: number): Promise<string[]> {
    const r = await exec('ssh-keyscan', ['-T', '10', '-p', String(port), host], {
      timeoutMs: 20_000,
    });
    return r.output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  }

  /** SHA256 fingerprints of known_hosts lines, as `ssh-keygen -l` prints them. */
  async fingerprints(hostKeys: string[]): Promise<string[]> {
    const r = await exec('ssh-keygen', ['-l', '-f', '-'], {
      stdin: hostKeys.join('\n') + '\n',
      timeoutMs: 10_000,
    });
    return r.output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async run(
    target: SshTarget,
    privateKey: string,
    command: string,
    opts: { stdin?: Buffer; timeoutMs: number; signal?: AbortSignal },
  ): Promise<SshResult> {
    return this.session(target, privateKey, (ssh) =>
      exec('ssh', [...ssh, `${target.user}@${target.host}`, '--', command], opts),
    );
  }

  /**
   * Bring a remote directory (relative to the user's home) up to date with a local working
   * tree: rsync where the server has it (deletions included; gitignored paths such as
   * node_modules are left alone, so they act as a cache), otherwise a tar of the tree's files.
   * `.git` stays behind.
   */
  async sync(
    target: SshTarget,
    privateKey: string,
    localDir: string,
    remoteDir: string,
    opts: { rsync: boolean; timeoutMs: number; signal?: AbortSignal },
  ): Promise<SshResult> {
    return this.session(target, privateKey, async (ssh) => {
      const dest = `${target.user}@${target.host}`;
      const mk = await exec('ssh', [...ssh, dest, '--', `mkdir -p ${remoteDir}`], opts);
      if (mk.exitCode !== 0) return mk;
      if (opts.rsync) {
        return exec(
          'rsync',
          [
            '-a',
            '--delete',
            '--filter=:- .gitignore',
            '--exclude=.git',
            '-e',
            ['ssh', ...ssh].join(' '),
            `${localDir}/`,
            `${dest}:${remoteDir}/`,
          ],
          opts,
        );
      }
      const files = await exec('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
        ...opts,
        cwd: localDir,
        binary: true,
      });
      const archive = await exec('tar', ['--null', '-T', '-', '-cf', '-'], {
        ...opts,
        cwd: localDir,
        stdin: files.stdout,
        binary: true,
      });
      return exec('ssh', [...ssh, dest, '--', `tar -xf - -C ${remoteDir}`], {
        ...opts,
        stdin: archive.stdout,
      });
    });
  }

  /** Copy `path` (relative to the remote directory) back into the local directory. */
  async fetch(
    target: SshTarget,
    privateKey: string,
    remoteDir: string,
    path: string,
    localDir: string,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<SshResult> {
    return this.session(target, privateKey, async (ssh) => {
      const r = await exec(
        'ssh',
        [...ssh, `${target.user}@${target.host}`, '--', `cd ${remoteDir} && tar -cf - -- ${path}`],
        { ...opts, binary: true },
      );
      if (r.exitCode !== 0) return { exitCode: r.exitCode, output: r.output };
      // Members are relative to the task folder; tar refuses `..` and absolute names.
      return exec('tar', ['-xf', '-', '--no-same-owner', '-C', localDir], {
        ...opts,
        stdin: r.stdout,
      });
    });
  }

  /** ssh options for one use: a private temp dir with the key and the pinned host keys. */
  private async session<T>(
    target: SshTarget,
    privateKey: string,
    fn: (sshArgs: string[]) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'orbot-ssh-'));
    try {
      const key = join(dir, 'key');
      const known = join(dir, 'known_hosts');
      await writeFile(key, privateKey.replace(/\r\n/g, '\n').trimEnd() + '\n', { mode: 0o600 });
      await writeFile(known, target.hostKeys.join('\n') + '\n', { mode: 0o600 });
      return await fn([
        '-F',
        '/dev/null',
        '-i',
        key,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${known}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        'ConnectTimeout=15',
        '-o',
        'ServerAliveInterval=30',
        '-T',
        '-p',
        String(target.port),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
