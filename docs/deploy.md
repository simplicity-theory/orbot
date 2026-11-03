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

| Option          | Default                 | Meaning                                                                                                           |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--origin URL`  | `http://localhost:PORT` | `ORBOT_WEB_ORIGIN`, where ORBOT is reached. `https://…` also sets `ORBOT_DOMAIN`, and `orbot up` then runs Caddy. |
| `--port N`      | `3000`                  | The port on this machine (loopback only; Caddy or your own proxy faces the internet).                             |
| `--runtime …`   | `simulated`             | `simulated` (scripted bots, free), `claude` (needs `ANTHROPIC_API_KEY` in `.env`), `claude-code`.                 |
| `--claude-home` | `~/.claude`             | For `claude-code`: the `claude` login to mount into the container.                                                |

For `claude-code`, run `claude` once as yourself and log in before `orbot up`. The container's
user (uid 1001) needs to read and write that folder; `orbot setup` grants it with an ACL
(`setfacl -R -m u:1001:rwX ~/.claude`), which leaves your own access as it was. Anthropic's
terms allow a Pro/Max login for one person's own use, so don't give other officers orders
while bots run on it.

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
Depot, or use **New project** on Operations for a single-HTML-file project.

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

## Every day

| Command                  | What it does                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `orbot status`           | Containers, health, the commit running and the commit checked out.                                                      |
| `orbot logs [db\|caddy]` | Follows the API's logs (JSON through the redacting logger; secret values never appear).                                 |
| `orbot backup [dir]`     | `record.dump`, `secrets.dump`, `workspaces.tar.gz` into `backups/<date>/`.                                              |
| `orbot restore DIR`      | Replaces both databases and the workspaces with a backup. Asks twice: it is the one operation that throws records away. |
| `orbot down`             | Stops everything. The record, secrets and workspaces stay in the Docker volumes.                                        |
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

## What this setup does not do yet

- One API process. The login throttle and the background job queues are in memory, so run one
  replica (the record itself is safe to share, but the Overseers would double up).
- No SSO or OAuth: the Commander has a passphrase, officers have a login and password.
- No outbound mail; alerts go to the push URL you store as a credential.
- Model keys for the `claude` runtime and server SSH keys live in the secrets store; the
  database and the key in `.env` are the two halves of that. There is no external KMS.
