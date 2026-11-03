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

`docs/deploy.md`: the checkout in `/var/www/orbot`, one `orbot` command to set up, start,
update and back it up; Docker Compose underneath, automatic HTTPS with a domain.

```bash
git clone <this repository> /var/www/orbot
sudo ln -sf /var/www/orbot/scripts/orbot /usr/local/bin/orbot
orbot setup --port 3001 --runtime claude-code   # or --origin https://orbot.example.com --runtime claude
orbot up                                        # later: orbot update
```
