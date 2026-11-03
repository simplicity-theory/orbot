# Running ORBOT

ORBOT runs as one Docker Compose project: Postgres (the record and the secrets store), the
API with the web app built in, and, when it has a domain, Caddy for HTTPS. The checkout lives
in `/var/www/orbot`, and everything an operator does goes through one command, `orbot`, which
is `scripts/orbot` in that checkout. Bots work inside the API container (git worktrees in a
volume) and on the servers you connect in the Supply Depot.

## What you need

- Linux with Docker Engine 24+ and the compose plugin, your user in the `docker` group,
  `git`, `openssl` and `curl`. For `claude-code` bots, `setfacl` (package `acl`).
- **On your own machine:** nothing else. ORBOT answers at `http://localhost:<port>`, the one
  plain-http origin it accepts.
- **On a server for others to reach:** a DNS name pointing at it, ports 80 and 443 open. Caddy
  gets the certificate. ORBOT refuses to start in production with a plain-http origin anyone
  else could reach, because the session cookie would travel in clear.
- For real bots: an Anthropic API key (`claude` runtime), or your own Claude plan signed in
  with Claude Code on the same machine (`claude-code` runtime; one Commander's own use only).
  The simulated runtime (scripted bots, free, for trying the command system) is not installed
  in production unless you choose it (`--runtime simulated`, or `ORBOT_SIMULATED=on`).

## Install

The code is at https://github.com/simplicity-theory/orbot (private: the machine needs an SSH
key or a token that can read it; a deploy key with read access is enough for `orbot update`).

```bash
sudo mkdir -p /var/www/orbot && sudo chown "$USER": /var/www/orbot
git clone git@github.com:simplicity-theory/orbot.git /var/www/orbot
sudo ln -sf /var/www/orbot/scripts/orbot /usr/local/bin/orbot
```

`orbot` always acts on the checkout it was linked from, whatever directory you run it in.

## Set up

`orbot setup` writes `/var/www/orbot/.env` (mode 600) from `deploy/orbot/env.production.example`
with every secret freshly generated, and prints your Commander passphrase once.

```bash
# Your own machine, bots on your Claude plan (the dev API uses 3000; take 3001):
orbot setup --port 3001 --runtime claude-code

# A server with a domain, bots on an API key:
orbot setup --origin https://orbot.example.com --runtime claude
```

| Option          | Default                 | Meaning                                                                                                                                                           |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--origin URL`  | `http://localhost:PORT` | `ORBOT_WEB_ORIGIN`, where ORBOT is reached. `https://…` also sets `ORBOT_DOMAIN`, and `orbot up` then runs Caddy.                                                 |
| `--port N`      | `3000`                  | The port on this machine (loopback only; Caddy or your own proxy faces the internet).                                                                             |
| `--runtime …`   | `claude-code`           | `claude-code` (your Claude plan), `claude` (needs `ANTHROPIC_API_KEY` in `.env`), or `simulated` (scripted bots, free; installed in production only when chosen). |
| `--claude-home` | `~/.claude`             | For `claude-code`: the `claude` login to mount into the container.                                                                                                |

For `claude-code`, run `claude` once as yourself and log in before `orbot up`. The container
runs as you (`orbot setup` writes your uid and gid into `.env` as `ORBOT_UID`/`ORBOT_GID`), so
it reads that login however Claude rewrites its files. Anthropic's terms allow a Pro/Max login
for one person's own use, so don't give other officers orders while bots run on it.

Anything else (`ORBOT_CLAUDE_MODEL`, the pace settings, `ORBOT_SEED`) is edited in `.env`.
`ORBOT_SEED=force` (the default) seeds the four units with their Overseers, bots and Field
Manuals and nothing else; `demo` adds the demo repositories and an operation; `none` leaves
the record empty.

## Start

```bash
orbot up
```

Builds the image (several minutes the first time), starts Postgres, applies the migrations,
seeds the force, waits until `/api/health` answers, and prints the address. Sign in with the
passphrase (`orbot passphrase` shows it again). Then connect your repositories in the Supply
Depot, or open a **New theatre** (Theatres: one per project, with its repository and the site
ORBOT publishes it to) and state your first intent in it.

## Update

```bash
orbot update
```

1. Fetches and lists the new commits on the current branch (and stops if the checkout has local
   changes).
2. Backs up both databases and the workspaces first (`orbot update --no-backup` skips it).
3. Pulls (fast-forward only), rebuilds the image stamped with the commit, restarts, and waits
   for health. Migrations are forward-only and run on start; the record is append-only, so an
   update never rewrites history.
4. Prints the commit now running. `orbot status` shows it next to the commit checked out at
   any time; `/api/health` carries it as `commit`.

If nothing new was pulled but the running build is older than the checkout, `orbot update`
rebuilds anyway.

A task that was running when the API restarted is queued again at boot, with the reason on
it, and goes on from its branch: an Overseer-issued task starts by itself, a task you started
waits for you to start it again. Nothing a bot had committed is lost.

## Every day

| Command                  | What it does                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `orbot status`           | Containers, health, the commit running and the commit checked out.                                                      |
| `orbot logs [db\|caddy]` | Follows the API's logs (JSON through the redacting logger; secret values never appear).                                 |
| `orbot backup [dir]`     | `record.dump`, `secrets.dump`, `workspaces.tar.gz` into `backups/<date>/`.                                              |
| `orbot restore DIR`      | Replaces both databases and the workspaces with a backup. Asks twice: it is the one operation that throws records away. |
| `orbot down`             | Stops everything. The record, secrets and workspaces stay in the Docker volumes.                                        |
| `orbot reset`            | Throws away the record, secrets and workspaces and starts fresh (asks for RESET). The force is seeded again.            |
| `orbot passphrase`       | Prints the Commander passphrase from `.env`.                                                                            |

Schedule `orbot backup` from cron (daily is reasonable) and copy `backups/` off the machine,
together with the `ORBOT_SECRETS_KEY` line of `.env`: the secrets dump is encrypted with that
key and cannot be read without it, and the record is useless to a bot without the credentials
it names.

## Health, monitoring

`GET /api/health` answers `{ ok, record, secrets, version, commit }` and 503 when a database
is down. Compose restarts the API on it; your monitoring can read it too. The API listens on
`127.0.0.1:<port>` (`ORBOT_BIND` in `.env` to change it); with a domain, Caddy proxies
`https://<domain>` to it and `ORBOT_TRUST_PROXY=on` makes client addresses and the scheme come
from its headers.

## Reaching it from other devices

Make the origin https: a domain pointed at the machine (`orbot setup --origin https://…`, or
set `ORBOT_WEB_ORIGIN` and `ORBOT_DOMAIN` in `.env` and `orbot up`), or a private network with
its own certificates (Tailscale's HTTPS names work with the same two settings). A plain-http
origin other than localhost is refused.

## When something goes wrong

Every error ORBOT shows says what happened and what to do next; this is where to look when it
is not obvious.

| What you see                                                            | What to do                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A task is **blocked** or **failed**                                     | Open it (Needs you lists them): the reason and a **What to do** line are on the task. Give what it asks for (an item from the Supply Depot, a decision, an order in chat), then **Resume** or **Retry**. If it says "Held again for the same reason", resuming alone will not clear it: change what causes it first. |
| A task reads **Working** but its last activity is old                   | Settings → **Restart the queues** (or in chat to HQ: "Restart the queues"): a task shown working with no run behind it is queued again and every unit dispatches. The escalation sweep does the same by itself every half minute, and so does every start of the API.                                                |
| A Guard finding holds the work you did not want held                    | Set the unit's hold policy (Rules tab, or in chat: "Guard, hold only on critical findings"; "Go fully automatic" never holds), or order the fix in chat ("Fix it").                                                                                                                                                  |
| "Needs a decision" in a sitrep, nothing in Needs you                    | The task is failed: it is on the bot's page and the unit's task list, with a Retry button.                                                                                                                                                                                                                           |
| "Claude Code is not signed in" although you are                         | The container cannot read `~/.claude/.credentials.json`. Check `.env` has `ORBOT_UID`/`ORBOT_GID` equal to `id -u`/`id -g` (an install from before D123 lacks them: add them, then `orbot up`), and that `claude` is logged in on this machine. Then Start over on the operation.                                    |
| A bot keeps failing with "runtime crashed" or "No bot runtime called …" | `orbot logs` shows the error. Settings shows each bot's runtime: for `claude-code`, run `claude` on the host and check the login is still valid; for `claude`, the API key in `.env`.                                                                                                                                |
| The sand table lists blockers                                           | Each blocker names its fix and links to where to do it (chat to HQ, the Supply Depot).                                                                                                                                                                                                                               |
| `orbot update` refuses: local changes                                   | `git -C /var/www/orbot status`; commit or discard them (`git checkout -- .`), then update again.                                                                                                                                                                                                                     |
| `orbot update` refuses: not a fast-forward / no common history          | The checkout and origin diverged (for instance after the repository's history was rewritten). `git -C /var/www/orbot fetch origin && git -C /var/www/orbot reset --hard origin/main`, then `orbot update`.                                                                                                           |
| `orbot up` waits for health and gives up                                | `orbot logs`: the first error after start says which setting is wrong (a plain-http origin, a database password, the secrets key). Fix `.env`, `orbot up` again.                                                                                                                                                     |
| "Something went wrong on our side" with a reference                     | `orbot logs \| grep <reference>` shows the redacted error. Retry once; if it repeats, report it with the reference.                                                                                                                                                                                                  |

## What this setup does not do yet

- One API process. The login throttle and the background job queues are in memory, so run one
  replica (the record itself is safe to share, but the Overseers would double up).
- No SSO or OAuth: the Commander has a passphrase, officers have a login and password.
- No outbound mail; alerts go to the push URL you store as a credential.
- Model keys for the `claude` runtime and server SSH keys live in the secrets store; the
  database and the key in `.env` are the two halves of that. There is no external KMS.
