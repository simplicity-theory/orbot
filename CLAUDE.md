# ORBOT

Command teams of software-development bots the way an officer commands units: state intent, issue orders, read reports.
The product name lives in one config value: `ORBOT_PRODUCT_NAME` (served by `GET /api/meta`). "ORBAT" is only the home screen's title.

## The five principles (they override everything else)

1. **Chain of command.** Commander → HQ → Units → Bots. Orders flow down, reports flow up. Each unit's Overseer directs its own bots.
2. **Chat is command.** An order given in chat changes the system, not only the conversation.
3. **Knowledge belongs to the unit, never the bot.** Any bot can be replaced; its successor continues from the unit's documents alone.
4. **Nothing is ever deleted.** Every document, chat and log is kept. A rewrite creates a new version and archives the old one.
5. **Secrets stay out of every record.** No secret value in any document, log, chat, archive, API response or error message.

If an implementation choice conflicts with a principle, the principle wins. Record judgement calls in `docs/decisions.md`.

## Commands

| What                                                                          | Command                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------- |
| Everything for local dev (Postgres, migrate, seed, shared+API+web with watch) | `npm run dev` → http://localhost:4200    |
| Start Postgres only                                                           | `npm run db:up`                          |
| Migrate / seed                                                                | `npm run db:migrate` / `npm run db:seed` |
| Unit tests (all workspaces)                                                   | `npm test`                               |
| API e2e (needs Postgres)                                                      | `npm run test:e2e`                       |
| UI tests (Playwright + axe; starts its own API on :3100 and web on :4300)     | `npm run test:ui`                        |
| Full CI                                                                       | `npm run ci`                             |
| Design-token guard                                                            | `node scripts/check-tokens.mjs`          |

The Commander passphrase is `ORBOT_COMMANDER_PASSPHRASE` in `.env` (generated on the first `npm run dev`).
Tests use the `orbot_test` / `orbot_secrets_test` databases and reset them; the dev databases are never touched by tests.

## Layout

- `packages/shared` — domain zod schemas, status vocabulary, `BotRuntime` interface, `Redactor`, glossary, request/view types. Build it (`npm run build -w @orbot/shared`) before the API or web can see changes (`npm run dev` watches it).
- `apps/api` — NestJS 12 (ESM). Key modules:
  - `record/` — `RecordService`: the append-only permanent record (versions, supersessions, events), history, as-of, diff, search.
  - `secrets/` — separate database + AES-256-GCM. The only code that can read a secret value.
  - `redaction/` — `RedactionService`, response interceptor, redacting pino logger. `common/error.filter.ts` redacts errors.
  - `execution/task-runner.ts` — drives a bot through a task: brief → workspace → runtime events → policy check → record.
  - `runtime/` — `RuntimeRegistry`, `SimulatedRuntime` + `scenarios/*.json`, `WorkspaceManager` (git worktree per task).
  - `policy/` — `PolicyService.check()`; every bot action passes through it (hook for ROE, budgets, stand-down, separation of duties).
  - `db/migrations/{record,secrets}/*.sql` — hand-written SQL, applied by `db/migrator.ts`.
- `apps/web` — Angular 22: standalone components, signals, `@if`/`@for`, lazy routes, OnPush (the Angular 22 default — never set `Eager`).
  - `core/` services, `ui/` in-house component library on Angular CDK, `shell/`, `features/<screen>/`.
  - `src/styles/_tokens.scss` — **the only place raw colours/sizes may appear**. Components use `var(--…)` (enforced by `scripts/check-tokens.mjs`).
  - `e2e/` — Playwright specs; `expectAccessible()` runs axe (WCAG 2.2 AA).

## Conventions

- **Append-only:** never write UPDATE/DELETE against the record. Use `RecordService.revise()` (new version + supersession stamp) or `.event()`. The DB enforces it (privileges + triggers) and `test/append-only.e2e-spec.ts` proves it.
- **Every write has an actor and a reason.** Actors are `commander:<id>`, `bot:<id>`, `system:<name>`.
- **Secrets by name only.** Bots get values only via `RunContext.withCredential(name, purpose, fn)`, which records the use by name. Never log, return or store a value; the redaction layer is a backstop, not permission.
- **Bot work goes through `BotRuntime`.** Nothing outside `runtime/` may know which runtime is in use.
- **Validation:** request bodies use shared zod schemas via `ZodPipe`. Entity bodies are validated on every write.
- **Errors** say what happened and what to do next (`{ error: { code, message, action } }`); never a stack trace.
- **UI status language:** always `<orb-status>` (colour + icon + label). Military terms get `<orb-term key="…">` (glossary in `packages/shared/src/glossary.ts`).
- **Deep links:** every object has a stable URL mirroring the chain of command (`/units/:u/bots/:b/tasks/:t`); view state lives in query params.
- **Pages** load with `httpResource`, show `<orb-skeleton>` (not spinners) while loading, `<orb-load-error>` on failure, and refresh via `reloadOnLive()`.
- Nest DI relies on decorator metadata: run API code through `nest build`/Vitest, not `tsx` (tsx is fine for DI-free scripts like `migrate`).
- Tests are written alongside code. Each phase's "done when" is an automated test.
