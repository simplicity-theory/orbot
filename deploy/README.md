# deploy/

What ORBOT puts on your servers. Each app is a folder in `apps/`; a server's page in the Supply
Depot lists them and installs them.

```
deploy/
  lib/common.sh          shared helpers for app scripts (state, steps, Docker, NVIDIA toolkit)
  server/facts.sh        what a server is (OS, GPU, Docker, sudo), read on connect and Check login
  server/workspace.sh    the bot workspace: a login without sudo for bots' dev work
  apps/<id>/
    app.json             manifest: name, settings, secrets, what it provides
    install.sh           installs or reinstalls it (safe to run again)
    status.sh            key=value lines: how it is doing
    uninstall.sh         removes it (keeps downloaded data)
```

## How an install runs

1. ORBOT copies `lib/` and `apps/<id>/` to `/opt/orbot` on the server.
2. It writes the settings and secrets to `/etc/orbot/apps/<id>.env` (root only, mode 600) as
   `KEY='value'` lines. Secret values travel over SSH stdin, never on a command line.
3. It starts `install.sh` as root with `systemd-run --unit=orbot-app-<id>-install`, logging to
   `/var/log/orbot/<id>-install.log`. The install keeps going if ORBOT or the connection stops.
4. ORBOT follows `/var/lib/orbot/apps/<id>/state`, which the script writes through
   `lib/common.sh`: `running <step>`, then `done` or `failed <step>: <why>`. When it is done, ORBOT
   runs `status.sh` and, if the manifest `provides` a model, adds it to the depot.

The login user needs passwordless sudo.

## Writing an app

- `app.json` follows `AppManifest` in `packages/shared/src/domain/apps.ts`. Setting keys are the
  environment variables the scripts read. Values may only use letters, digits, spaces and
  `. _ / : @ + = , -`, so they are safe in the env file.
- A secret with `"generate": true` is made by ORBOT and stored as a credential. Others are
  credentials the Commander chooses when installing.
- Start scripts with `export APP=<id>` and source `../../lib/common.sh`, call `load_env`, and mark
  progress with `step "…"`. Any failing command fails the install at the current step. End with
  `state "done"` (install) or `state removed` (uninstall).
- Never put a secret on a command line: every local user can read process arguments. Pass it in
  an environment variable or on stdin (e.g. `printf 'Authorization: Bearer %s\n' "$KEY" | curl -H @- …`).
- Lint with `docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:v0.10.0 -x lib/*.sh apps/*/*.sh server/*.sh`.
