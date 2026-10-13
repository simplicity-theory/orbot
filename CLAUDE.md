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
  - `overseer/` — `OverseerService` (missions → backbriefs → tasks, dispatch, unit sitreps, reassign, replace bots), `BriefingService` (handover + Field Manual + War Diary → `TaskBrief`, `task.briefed` event), `CurationService`, `ColdStartService`.
  - `overseer/hq.service.ts` — `HqService` (actor `system:hq`): operation → O Group plan → chained missions on an integration branch → backbriefs → execution → handoffs/send-backs → deploy approval → After Action review → closed; renders the operation's shared record document.
  - `runtime/claude.runtime.ts` — `ClaudeRuntime` (Messages API tool loop confined to the worktree; structured outputs for Overseer/HQ). Registered only if `ANTHROPIC_API_KEY` is set; tests use a scripted fake client.
  - Phase 5 command services in `overseer/`:
    - `StandDownService`: halt orders on a bot, a unit or everything; running work pauses with a handover.
    - `BudgetService`: hard caps per unit, operation and task, with a warning first.
    - `EscalationService`: stalls, timeouts and repeated failures go Overseer → HQ → Commander.
    - `DeconflictionService`: who touches what, worked out from git; HQ notices overlaps.
    - `DisputeService`: HQ rules under standing orders; the Commander's ruling is final.
    - `MainEffortService`: one operation goes first; supporting work makes way (moved to a free bot, or paused with a handover). `main-effort.ts` holds the dispatch-order helpers.
      Each registers its own `PolicyRule` and/or bus listener.
  - `policy/duties.service.ts` — separation of duties as a `RecordService` write guard: no bot approves its own work, changes its own rules or grants itself supply, by any path.
  - `chat/` — `ChatService` (message → `runtime.interpret` → actions/pending → orders log → read-back; undo; confirm/decline) and `ActionsService` (one executor per `ChatAction`, each returning its inverse).
  - `settings/` — the versioned settings entity (irreversible action kinds, confirmation phrase).
  - `documents/` — `FieldManualService` (entries, render/parse), `UnitDocsService` + `UnitDocumentStore` (Markdown mirror in the unit's repo, import of human edits).
  - `common/background.ts` — per-key serial job runner for bus-driven work; tests wait with `settled()` (`src/testing/settle.ts`).
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
- **Knowledge belongs to the unit.** A bot's brief comes only from `BriefingService` (unit documents). Never pass a bot information from another bot's memory or run; if a successor needs it, it belongs in a handover or the Field Manual.
- **Field Manual edits go through entries** (`FieldManualService.promote/merge/edit/retire/reinstate` + `rerender` in the same transaction). Never rewrite the `field-manual` document directly.
- **Chat changes go through `ActionsService`.** Add a new chat capability by adding a `ChatAction` kind (shared zod union), an executor that calls existing services and returns its inverse, and interpreter support. Never act on free text.
- **Bus reactions go through `Background.run(key, …)`** with key `unit:<id>` (or `docs:<id>`) so a unit's work stays ordered.
- **New limits on bots go in the policy layer.** Add a `PolicyRule` (bot actions: `task.start`, `task.continue`, `bot.*`) or a record write guard (entity changes). Never scatter `if` checks across controllers.
- Tests are written alongside code. Each phase's "done when" is an automated test.
