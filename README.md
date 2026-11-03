# ORBOT

Command teams of software-development bots the way an officer commands units: state intent,
issue orders, read reports. HQ plans an operation, each unit (Engineers, Inspection, Guard,
Logistics) briefs back its plan, bots work in their own git worktrees, and everything they do is
on a permanent, append-only record. Chat is command: an order in chat changes the system.

## Develop

Needs Node 24+ and Docker.

```bash
npm install
npm run dev        # Postgres, migrations, demo force, API and web with watch → http://localhost:4200
```

The Commander passphrase is printed on the first run (and kept in `.env`). `npm test`,
`npm run test:e2e` and `npm run test:ui` cover the three layers; `npm run ci` runs everything.
Conventions, layout and the five principles are in `CLAUDE.md`; design decisions in
`docs/decisions.md`.

## Run it for real

`docs/deploy.md`: one server, Docker Compose, automatic HTTPS, backups and upgrades.

```bash
cp deploy/orbot/env.production.example .env   # fill it in
docker compose -f docker-compose.prod.yml --profile tls up -d --build
```
