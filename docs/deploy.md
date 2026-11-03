# Running ORBOT in production

One Linux server, Docker Compose, one origin. The API serves the built web app, Postgres holds
the record and the secrets store, and Caddy (optional) terminates HTTPS. Everything a bot does
runs inside the API container (git worktrees under a volume) or on the servers you connect in
the Supply Depot.

## What you need

- A Linux VPS (2 CPU, 4 GB RAM, 20 GB disk is enough to start) with Docker Engine 24+ and the
  compose plugin. Your user in the `docker` group.
- A DNS name pointing at it (for HTTPS), ports 80 and 443 open. Without a domain, run it on a
  private network and put your own TLS in front: the session cookie is marked `Secure` as soon
  as `ORBOT_WEB_ORIGIN` is https, and the API refuses a plain-http origin other than localhost.
- For real bots: an Anthropic API key (`claude` runtime), or your own Claude plan signed in
  with Claude Code on the server (`claude-code` runtime; one Commander's own use only).

## First deployment

```bash
git clone <your fork or this repository> orbot && cd orbot
cp deploy/orbot/env.production.example .env
chmod 600 .env
```

Fill in `.env`. Generate what must be random:

```bash
openssl rand -base64 32   # ORBOT_SECRETS_KEY (exactly 32 bytes, base64)
openssl rand -base64 32   # ORBOT_SESSION_SECRET
openssl rand -base64 18   # ORBOT_COMMANDER_PASSPHRASE
openssl rand -base64 24   # POSTGRES_ADMIN_PASSWORD, ORBOT_DB_OWNER_PASSWORD,
                          # ORBOT_DB_APP_PASSWORD, ORBOT_DB_SECRETS_PASSWORD (one each)
```

Set `ORBOT_DOMAIN` and `ORBOT_WEB_ORIGIN=https://<ORBOT_DOMAIN>`. Then:

```bash
docker compose -f docker-compose.prod.yml --profile tls up -d --build
docker compose -f docker-compose.prod.yml logs -f api
```

The first start builds the image (several minutes), waits for Postgres, applies the
migrations, seeds the force (`ORBOT_SEED=force`: Engineers, Logistics, Inspection and Guard
with their Overseers, bots and Field Manuals, nothing else) and listens. Caddy fetches a
certificate for `ORBOT_DOMAIN`. Open `https://<ORBOT_DOMAIN>` and sign in with
`ORBOT_COMMANDER_PASSPHRASE`.

Without the `tls` profile the API listens on `127.0.0.1:3000` only (`ORBOT_BIND`,
`ORBOT_API_PORT`); point your own reverse proxy at it and keep `ORBOT_TRUST_PROXY=on` so client
addresses and the scheme come from its `X-Forwarded-*` headers.

The container refuses to start in production with placeholder database passwords or a
plain-http origin, and says which setting to fix.

## Choosing the bot runtime

| `ORBOT_RUNTIME` | Needs                                                           | Billed to        |
| --------------- | --------------------------------------------------------------- | ---------------- |
| `simulated`     | nothing (scripted bots; for trying the command system)          | nothing          |
| `claude`        | `ANTHROPIC_API_KEY`                                             | the API key      |
| `claude-code`   | the `claude` login mounted at `/home/orbot/.claude` (see below) | your Claude plan |

For `claude-code`: install Claude Code on the server, run `claude` once as the user who runs
compose and log in, then set `ORBOT_CLAUDE_HOME=/home/<you>/.claude` and
`ORBOT_RUNTIME=claude-code` in `.env`. The container user (uid 1001) must be able to read and
write that directory (`chown -R 1001:1001` or a group with write access). Anthropic's terms
allow a Pro/Max login for one person's own use, so do not give other officers orders while
bots run on it.

The model for both Claude runtimes is `ORBOT_CLAUDE_MODEL`.

## After the first start

- **Connect your repositories** in the Supply Depot (a clone URL, with a token stored as a
  credential and referenced by name), issue them to units, and state your first intent.
- **Servers** your bots should use (dev servers, staging, production) are connected with an
  SSH key stored as a credential. The container ships git, ssh and rsync.
- **Other officers** are added under Officers; they sign in with their own login.

## Health, logs, updates

- `GET /api/health` answers `{ ok, record, secrets, version }` and 503 when a database is
  down. Compose uses it; so can your monitoring.
- Logs go to stdout as JSON through the redacting logger: `docker compose -f
docker-compose.prod.yml logs -f api`. Secret values never appear in them.
- **Upgrading:** `git pull`, then `docker compose -f docker-compose.prod.yml up -d --build`.
  Migrations are forward-only and run on start; the record is append-only, so an upgrade
  never rewrites history.

## Backups

```bash
scripts/backup.sh                  # → backups/<date>/ record.dump, secrets.dump, workspaces.tar.gz
scripts/restore.sh backups/<date>  # replaces both databases and the workspaces; asks twice
```

Keep the backup folder **and** the `ORBOT_SECRETS_KEY` line of `.env` somewhere other than the
server. The secrets dump is encrypted with that key and cannot be read without it; the record
is useless to a bot without the credentials it names. Schedule `scripts/backup.sh` from cron
(daily is reasonable) and copy the folder off the machine.

## What this setup does not do yet

- One API process. The login throttle and the background job queues are in memory, so run one
  replica (the record itself is safe to share, but the Overseers would double up).
- No SSO or OAuth: the Commander has a passphrase, officers have a login and password.
- No outbound mail; alerts go to the push URL you store as a credential.
- Model keys for the `claude` runtime and server SSH keys live in the secrets store; the
  database and the key in `.env` are the two halves of that. There is no external KMS.
