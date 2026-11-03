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

| What                                                                                                  | Command                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Everything for local dev (Postgres, migrate, seed, shared+API+web with watch)                         | `npm run dev` → http://localhost:4200       |
| Start Postgres only                                                                                   | `npm run db:up`                             |
| Migrate / seed                                                                                        | `npm run db:migrate` / `npm run db:seed`    |
| Unit tests (all workspaces)                                                                           | `npm test`                                  |
| API e2e (needs Postgres)                                                                              | `npm run test:e2e`                          |
| UI tests (Playwright + axe; starts its own API on :3100 and web on :4300)                             | `npm run test:ui`                           |
| Full CI                                                                                               | `npm run ci`                                |
| Design-token guard                                                                                    | `node scripts/check-tokens.mjs`             |
| Production (checkout in `/var/www/orbot`; `scripts/orbot` wraps Docker Compose; see `docs/deploy.md`) | `orbot setup` / `orbot up` / `orbot update` |

The Commander passphrase is `ORBOT_COMMANDER_PASSPHRASE` in `.env` (generated on the first `npm run dev`).
Tests use the `orbot_test` / `orbot_secrets_test` databases and reset them; the dev databases are never touched by tests.
`docs/deploy.md` is how ORBOT is run as production software (`scripts/orbot`: setup, up, update, status, backup, restore; the image, compose and Caddy underneath); `ORBOT_SEED=force` seeds the units without the demo.

## Layout

- `packages/shared` — domain zod schemas, status vocabulary, `BotRuntime` interface, `Redactor`, glossary, request/view types. Build it (`npm run build -w @orbot/shared`) before the API or web can see changes (`npm run dev` watches it).
- `apps/api` — NestJS 12 (ESM). Key modules:
  - `record/` — `RecordService`: the append-only permanent record (versions, supersessions, events), history, as-of, diff, search.
  - `secrets/` — separate database + AES-256-GCM. The only code that can read a secret value.
  - `redaction/` — `RedactionService`, response interceptor, redacting pino logger. `common/error.filter.ts` redacts errors.
  - `execution/task-runner.ts` — drives a bot through a task: brief → workspace → runtime events → policy check → record. A held task (blocked, awaiting a decision) frees its bot; `resume()` restarts it now or first in its bot's queue (D101). A task that stops short carries `statusReason` and `statusAction` (what the Commander can do about it: the bot's own `action`, else the usual way out; the same hold again says resuming alone will not clear it), shown on the task page and in Needs you; a failed task can be retried (D112); in an automatic theatre HQ retries it once itself on the same branch (D128). A `check` task starts while the unit before it builds: it prepares its test plan and harness, holds with `READY_FOR_HANDOFF` (never shown in Needs you), and HQ queues it again with a Frago at the handoff; its commits are integrated and landed like any unit's (D129). Runs live in the process: at boot, every task the record shows working is queued again with the reason and its bot freed, so an update or a crash never leaves a task working for ever; `recoverStranded` also runs on every escalation sweep and behind "Restart the queues" (`POST /api/queues/restart`, chat `restart-queues`, Settings) (D115). A `permission` event (bot tool `request_permission`, for what the unit's rules of engagement say must be escalated) parks the task in `awaiting-approval`; `OverseerService.decidePermission` resumes it with the decision in its brief (D98).
  - `runtime/` — `RuntimeRegistry`, `SimulatedRuntime` + `scenarios/*.json`, `WorkspaceManager` (git worktree per task).
  - `overseer/` — `OverseerService` (missions → backbriefs → tasks, dispatch, unit sitreps, reassign, replace bots), `BriefingService` (handover + Field Manual + War Diary → `TaskBrief`, `task.briefed` event), `CurationService`, `ColdStartService`.
  - `overseer/recommendations.service.ts` — `RecommendationsService`: what HQ recommends after an After Action review because it came up before in the theatre (a `rule` two reviews drew, a `fix` for a finding two operations left open), from the `after-action` event over the bus; shown under Needs you with one button, never a stop; adopted (standing order, or an operation launched) or dismissed, and not raised again (D130) (`GET /api/recommendations`, `POST /api/recommendations/:id/adopt|dismiss`; chat `adopt-recommendation`, `dismiss-recommendation`).
  - `overseer/campaigns.service.ts` — `CampaignsService`: a campaign is a sequence of operations toward one end inside a theatre; HQ launches each step as an operation when the one before it closes; a cancelled step holds the campaign for the Commander (start over, skip, call off) (D126) (`POST /api/theatres/:id/campaigns`, `/campaigns/:id/resume|cancel`; chat `create-campaign`, `resume-campaign`, `cancel-campaign`). `ConnectionsService.putTheatreOnGitHub` (`POST /api/theatres/:id/github`, chat `github-theatre`) creates the repository on GitHub if need be, connects it and pushes main now and after every landing (D127).
  - `overseer/theatres.service.ts` — `TheatresService`: a theatre is a software project, the standing home of one codebase: its repository (first: where work lands), its site or environments, and whatever else its operations share; an operation launched in it starts with all of it; a fully automatic theatre (the default) pre-approves plans, holds nothing on a finding, trims a single-file project to build → inspect, and at the end HQ lands the integration branch on the default branch and publishes it to the site (D122) (`POST /api/theatres`, `/theatres/:id/operations`, chat `create-theatre`; `create-operation` takes `theatreId`). "New project" opens a theatre with a template repository and a site (D121).
  - `overseer/hq.service.ts` — `HqService` (actor `system:hq`): operation (with resources: `supplyIds`, `needs`; a missing required need holds it at the O Group, `assignResource`/`releaseResource`, `setMainRepository` re-issues the missions on a new main repository, `cancelOperation` (D102); `abortMission`, `restartMission` (withdrawn and issued again in the same place in the chain), `restartOperation` (every mission issued again from the same plan) (D113); helpers in `packages/shared/src/domain/resources.ts`) → O Group plan → chained missions on an integration branch → backbriefs → execution → handoffs/send-backs → deploy approval → After Action review → closed; renders the operation's shared record document.
  - `runtime/claude-common.ts` — `ClaudeFamilyRuntime`: the bot tools, prompts and Overseer/HQ structured outputs shared by both Claude runtimes.
  - `runtime/claude.runtime.ts` — `ClaudeRuntime` (`claude`: Messages API tool loop confined to the worktree). Registered only if `ANTHROPIC_API_KEY` is set; tests use a scripted fake client.
  - `runtime/claude-code.runtime.ts` — `ClaudeCodeRuntime` (`claude-code`: Claude Agent SDK on the Commander's own Claude plan via the `claude` login; only ORBOT's tools over in-process MCP, allow-listed env with no API key). Registered when `ORBOT_CLAUDE_CODE=on` or `ORBOT_RUNTIME=claude-code`; tests use a scripted fake SDK.
  - Phase 5 command services in `overseer/`:
    - `StandDownService`: halt orders on a bot, a unit or everything; running work pauses with a handover.
    - `BudgetService`: caps per unit, operation and task, with a warning first; held only while the `computeLimits` setting is on (off by default: caps are advisory, spend is still recorded; `GET /api/compute` sums it per task, unit and operation as the baseline, D114).
    - `EscalationService`: stalls, timeouts and repeated failures go Overseer → HQ → Commander.
    - `DeconflictionService`: who touches what, worked out from git; HQ notices overlaps.
    - `DisputeService`: HQ rules under standing orders; the Commander's ruling is final.
    - `MainEffortService`: one operation goes first; supporting work makes way (moved to a free bot, or paused with a handover). `main-effort.ts` holds the dispatch-order helpers.
    - `ReconService`: read-only survey tasks that file a `recon` report with the unit (a policy rule keeps them read-only).
    - `SandTableService`: rehearses an operation's plan against the record (deterministic, changes nothing).
    - `DailyBriefService` (HQ's dated daily brief document) and `AlertService` (phone alerts: POST to a push URL held in the secrets store by name; `alert.sent` events).
      Each registers its own `PolicyRule` and/or bus listener.
  - `policy/hold-policy.service.ts` — `HoldPolicyService`: the hold policy (what a bot fixes alone, what it records, what holds the work for the Commander; `holdFrom`/`fixUpTo`, `never` = automatic), per unit with a per-operation override; briefed, not enforced (`decideFinding` in shared; the simulated `finding` step applies it) (D106).
  - `policy/duties.service.ts` — separation of duties as a `RecordService` write guard: no bot approves its own work, changes its own rules or grants itself supply, by any path.
  - `domain/service-record.service.ts` — a bot's service record, computed from the record (conduct, not knowledge: never briefed).
  - `officers/` — `OfficersService` (officer entities; passwords hashed in the secrets store as `officer-login.<id>`), `AuthorityService` + `AuthorityGuard` (rank checks on every write).
  - `servers/` — `ServersService` + `SshClient`: environments that are servers. Bots run commands and upload their committed work over SSH (key by credential name in a temp file, pinned host keys, no agent/config); every command on the record as `server.command`; production only inside an approved deploy (policy rule). Dev servers (tier `dev`): `devRun` syncs the bot's working tree to `~/orbot-dev/<repo>/<bot>` (rsync, else tar) and runs there; `devFetch` copies files back. The bot workspace (`setupWorkspace`) gives dev work its own login without sudo (`orbot-dev`, ORBOT-generated key); a server that runs apps refuses bots its admin login outside an approved deploy (policy rule).
  - `servers/apps.service.ts` — `AppsService`: installs apps from `deploy/apps/<id>` (manifest + scripts) on a server under `systemd-run`, follows the state file they write, and adds what they provide (a `model` supply item: OpenAI-compatible URL, model, key by name). See `deploy/README.md`. `HealthService`: a server's health check (login, each app's `status.sh`, disks) as a `server.health` event.
  - `servers/sites.service.ts` — `SitesService`: static sites (environments with no server, `spec.site`): `publish` takes files from a task's HEAD into `<dir>/versions/<stamp>` and points `current` at it (`deployment` event with the URL); a policy rule allows production sites only inside an approved deploy. `SitesController` serves `current` at `/api/sites/:id/` to anyone, sandboxed by CSP, and `/download` (D104).
  - `supply/templates.ts` + `SupplyService.createRepository` — repositories started from a template (`single-html`, `empty`); the shape stays on the depot item (`RepositorySupply.project`) and is briefed to bots, Overseers and HQ. `supply/projects.service.ts` — `ProjectsService`: one order (`POST /api/projects`, chat `new-project`) makes the repository, its site, deploy rights if confirmed, and the operation.
  - `code/` — `CodeService`: the code bots wrote, read straight from git (read-only, never copied into the record): repository history per branch, commits with diffs (`diff.ts` parses them), a task's changes, each commit tied to the task/bot/operation by the events that name it (D103).
  - `connections/` — `ConnectionsService` + `Connector` (GitHub adapter): push and pull requests, pipeline results (a red pipeline holds production deploys via a policy rule), issues taken on as missions. Tokens by credential name only.
  - `chat/` — `ChatService` (message + the channel's recent history → `runtime.interpret` → actions/pending → orders log → read-back; undo; confirm/decline; "Do it" confirms the last proposal (D108); a mission ordered in chat is `preApproved` (D107)) and `ActionsService` (one executor per `ChatAction`, each returning its inverse).
  - `settings/` — the versioned settings entity (irreversible action kinds, confirmation phrase).
  - `documents/` — `FieldManualService` (entries, render/parse), `UnitDocsService` + `UnitDocumentStore` (Markdown mirror in the unit's repo, import of human edits).
  - `common/background.ts` — per-key serial job runner for bus-driven work; tests wait with `settled()` (`src/testing/settle.ts`).
  - `policy/` — `PolicyService.check()`; every bot action passes through it (hook for ROE, budgets, stand-down, separation of duties).
  - `db/migrations/{record,secrets}/*.sql` — hand-written SQL, applied by `db/migrator.ts`.
- `deploy/` — what ORBOT puts on servers: `apps/<id>/` (app.json, install/status/uninstall.sh), `lib/common.sh`, `server/facts.sh`, `server/workspace.sh`. Lint with shellcheck (see `deploy/README.md`).
- `apps/web` — Angular 22: standalone components, signals, `@if`/`@for`, lazy routes, OnPush (the Angular 22 default — never set `Eager`).
  - `core/` services, `ui/` in-house component library on Angular CDK, `shell/`, `features/<screen>/`.
  - `src/styles/_tokens.scss` — **the only place raw colours/sizes may appear**. Components use `var(--…)` (enforced by `scripts/check-tokens.mjs`).
  - `e2e/` — Playwright specs; `expectAccessible()` runs axe (WCAG 2.2 AA).

## Conventions

- **Append-only:** never write UPDATE/DELETE against the record. Use `RecordService.revise()` (new version + supersession stamp) or `.event()`. The DB enforces it (privileges + triggers) and `test/append-only.e2e-spec.ts` proves it.
- **Every write has an actor and a reason.** Actors are `commander:<id>`, `officer:<id>`, `bot:<id>`, `system:<name>`.
- **Ranks (officers):** every write route is the Commander's alone unless it declares `@Authority({ level: 'read' | 'officer' | 'unit', units })` (`officers/authority.ts`). Chat orders are checked per action in `ChatService`. In the web, hide what someone can't order with `*orbCan` (the server enforces it either way).
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
