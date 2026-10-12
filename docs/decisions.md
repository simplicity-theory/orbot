# Decisions

Judgement calls made where the design was ambiguous or a choice had to be made. Newest last.

## Phase 1

**D1. npm workspaces, not Nx.** Three packages; Nx adds tooling weight without a clear win. Angular CLI and Nest CLI run per workspace.

**D2. Drizzle, not Prisma; hand-written SQL migrations.** The important parts of the schema are SQL-level — append-only triggers, GRANT/REVOKE, generated `tsvector` columns, a deferred version-chain constraint trigger, views. Drizzle is SQL-first and stays out of the way; we use it for typed queries only. Migrations are plain `.sql` files applied in order by a ~50-line migrator that records itself in the (append-only) `schema_migration` table.

**D3. "Superseded-at" is a row, not a column.** Stamping the old version with superseded-at/by/why would be an UPDATE. Instead each supersession is an insert into `record_supersession` (entity, version, superseded-by-version, at, by, reason). `record_active` and `record_archive` views join them. A deferred constraint trigger refuses any version N>1 that isn't committed together with the stamp on N−1, so history can't fork or skip.

**D4. All domain objects are versioned entities in the record.** Units, bots, operations, missions, tasks, supply and documents are not mutable tables: every change (including a bot's status) is a new version with an actor and a reason. Current state = `record_active`. Immutable things (War Diary, sitreps, working-record steps, chat, credential use, policy holds, redactions) are `record_event` rows.

**D5. Append-only is enforced twice.** (1) The API connects as `orbot_app`, which has only SELECT and INSERT. (2) Row and TRUNCATE triggers raise `OR001` for every role, including the table owner. Superusers and `ALTER TABLE … DISABLE TRIGGER` by the owner remain possible at the database level; the owner credentials are used only for migrations.

**D6. The secrets store is a separate database with its own role,** values AES-256-GCM encrypted with `ORBOT_SECRETS_KEY`, the secret's name bound as AAD. It is the one place rows change: rotating a secret overwrites the old ciphertext (keeping old secret values around would be worse than the principle-4 exception). Every store/rotate/revoke is logged in the record by name. `orbot_app` cannot connect to it (tested).

**D7. Redaction masks rather than rejects record writes.** Blocking a bot's diary entry because it pasted a token would lose the rest of the entry; masking keeps the record useful and safe. Each masking writes a `redaction.applied` event naming the detector (never the value). The redactor knows every live secret (exact match plus base64/URL/JSON-escaped variants) and also pattern-matches unknown secrets (provider token formats, PEM keys, `password=…`, URL credentials, high-entropy strings). The high-entropy detector judges path/URL segments individually so filesystem paths aren't masked. Revoked and rotated values stay known to the redactor for the life of the process.

**D8. Policy hook records holds, not every allow.** Every bot event and credential use passes through `PolicyService.check()`. Recording every allowed check would double the record without adding information (the resulting entry is the evidence it was allowed), so only refusals/escalations are written. Phase 1 has no rules.

**D9. `BotRuntime` is just `run(brief, ctx) → AsyncIterable<BotEvent>`.** Workspaces are prepared by `WorkspaceManager` (HQ needs to know who touches what for deconfliction), not by the runtime. Credentials reach a runtime only through `ctx.withCredential`, so a runtime cannot forget to record the use.

**D10. Connected repositories are always cloned.** ORBOT works from its own clone under `ORBOT_WORKSPACES_DIR/repos/<id>` and makes a worktree per task (`orbot/task-<n>`), so bot branches never touch the Commander's checkout. Worktrees are never removed.

**D11. Scenario-driven simulation.** `SimulatedRuntime` plays JSON scenarios (`happy-path`, `blocked-on-dependency`, `tests-fail`, plus test-only `rogue-leak`/`rogue-crash`). Text variation uses a PRNG seeded only by the scenario, so a scenario always plays out the same way. `ORBOT_SIM_SPEED` scales waits (0 in tests and seeding).

**D12. Operation lifecycle state machine.** Phases are Intent → O Group → Backbrief → Execution → Handoffs/Sitreps → After Action → Closed, with a rejected backbrief returning to O Group. A Frago is an event allowed in any phase before After Action, not a phase. (Encoded in `packages/shared/src/domain/operation-lifecycle.ts`; used from Phase 4.)

**D13. Auth: single Commander, signed session cookie.** Passphrase from env, HMAC-signed httpOnly cookie, `Principal { kind, id, displayName, rank? }` on every request so officers with ranks slot in later.

**D14. SCSS + CSS custom properties, no Tailwind; a script instead of Stylelint.** Tokens are the single source of truth. `scripts/check-tokens.mjs` fails CI on raw colours/lengths in component styles (media-query breakpoints exempt, since custom properties can't be used there).

**D15. Vitest everywhere.** Angular 22 and Nest 12 both default to it. API e2e tests run serially against `orbot_test`, which each suite resets (refused for any database not ending in `_test`).

**D16. Glossary lives in `packages/shared/src/glossary.ts`** (not a YAML file as first planned), so API and web share one typed source.

**D17. Search snippets are plain text.** `ts_headline` marks matches with `⟦…⟧`; the web app splits on those and renders `<mark>` itself, so record content is never interpreted as HTML.

**D18. Phase 1 screens beyond the bare shell.** ORBAT, Unit, Bot, Task, Archive (search + history/diff/as-of), Sitreps (read-only feed) and a Needs-you list are built minimally on the real API, because the Phase 1 test ("every step can be found in the record") is best demonstrated in the UI. Phase 2 polishes them (inline approvals, command palette, tree view).

**D19. Rogue scenarios ship with the runtime.** `rogue-leak` and `rogue-crash` exist to prove principle 5 end-to-end; they're harmless (the redactor masks them) and useful for demonstrating redaction.

## Phase 2

**D20. Overseers think through `BotRuntime`.** Overseers are bots (settled decision), so planning (`draftBackbrief`), curation (`curate`) and cold-start checks (`assessColdStart`) are runtime methods. `SimulatedRuntime` answers them with deterministic rules (`runtime/simulated-overseer.ts`); `ClaudeRuntime` will use the model. Nothing outside `runtime/` knows which brain is in use.

**D21. The Field Manual is a set of versioned entries.** Each lesson is an `fm-entry` with its own history and provenance (`sources`: handover id + version, commander, git, cold-start). Merging a repeated lesson adds a source instead of a duplicate; retiring sets `retired: true` (a new version), which moves it to the archive tier — search treats a retired entity's current version as archived. The unit's `field-manual` document is re-rendered from active entries in the same transaction, so whole-document history/diff/as-of keep working. That document cannot be rewritten as a blob (400 with a pointer to entries).

**D22. Only general lessons are promoted automatically.** The simulated Overseer promotes `flagsForSuccessor` items that don't name a specific task, branch or "yet"; task-specific notes and tried-and-failed items stay in the handover, which a successor on the same task is briefed with anyway. This keeps the Field Manual from filling with noise.

**D23. Unit documents in git, one-way mirror plus import.** `UnitDocumentStore` (interface) / `GitDocumentStore` writes `.orbot/units/<slug>/` on an `orbot/unit-docs` branch of the unit's first connected repository, via its own worktree, committing each batch of changes (coalesced per unit). Field Manual sections carry hidden `<!-- fm:<id> -->` markers so human edits map back to entries; standing orders carry `<!-- so:<id> -->`. `sync()` imports human edits as new versions by `system:git-import` and runs before every briefing. War Diary files are read-only (events are immutable); edits are restored and reported. Units without a repository simply have no mirror. Pushing the branch upstream is a Phase 4 connections concern.

**D24. Approval gates.** `approve-everything` and `backbriefs-and-deploys` both hold backbriefs for the Commander; `escalations-only` auto-approves (decision recorded as `auto-approved` by the Overseer). Deploy gating arrives with Logistics in Phase 4.

**D25. Commander → unit missions are a temporary shortcut.** Until HQ exists (Phase 4), the Commander gives a mission straight to a unit's Overseer (`POST /missions`, "New mission" on the unit view). Missions may have `operationId: null`.

**D26. Dispatch only what the Overseer issued.** Tasks created from an approved backbrief carry `autoStart: true` and are started by the Overseer's dispatcher whenever their bot is idle. Tasks issued directly by the Commander are started by hand ("Start task"), which keeps the Commander in control of ad-hoc work.

**D27. Reject = re-plan in place.** Sending a backbrief back writes a `rejected` version with the note, then the Overseer writes the next round as a new version of the same backbrief (round + 1, notes carried forward). History shows every round.

**D28. Approvals have no Undo.** Approving issues tasks that may start at once; a reversing entry can't un-run work. The toast says so. Field Manual, standing-order and document edits do have Undo (a new version restoring the old text; retire is undone by reinstating).

**D29. Background work is serialized per unit.** Bus-driven reactions (plan, curate, dispatch, after-task sitreps, docs mirror) run through `Background`, one job at a time per key, so an Overseer never acts on a half-applied change. Tests and the seed wait on `settled()` (no pending jobs, no running bots).

**D30. "A fresh bot" is proven, not assumed.** The `relay` scenario's second half reads only the brief: it blocks if the handover or the Field Manual convention is missing. The Phase 2 test runs it with the documents, then twice with them withheld (handover; Field Manual + search), and both controls block naming what's missing. The only thing a successor inherits physically is the branch.

**D31. Unit view sections are navigation, not tabs.** Overview / Field Manual / War Diary / Handovers / Rules / Supply are links (`?section=`) with `aria-current`, so each is deep-linkable and the back button works.

**D32. Keyboard.** Ctrl/⌘+K command palette (ARIA combobox + listbox, CDK dialog focus trap); `g` then `o/a/s/r/p/,` to go to screens; `?` for the cheat sheet. Shortcuts are ignored while typing in a field, except Ctrl/⌘+K.

## Phase 3

**D33. The Overseer interprets chat through `BotRuntime.interpret`.** It returns an `Interpretation` (zod-validated): message kinds, typed `ChatAction`s, musings, missing supply, an answer, and anything unclear. `SimulatedRuntime` uses a deterministic sentence-by-sentence rules/keyword classifier (`runtime/simulated-interpreter.ts`), so chat works offline and in tests. HQ has no Overseer bot until Phase 4, so the HQ channel is read by the default runtime, acting as `system:hq`.

**D34. Chat can only emit a closed set of actions.** `create-mission`, `withdraw-mission`, `frago` (stand down / amend), `resume`, `rule-change`, `supply-grant`, `supply-revoke`, `budget-grant`, `grant-deploy-rights`. Each runs through `ActionsService`, which calls the same services the UI uses, and returns a summary, links and its inverse. Chat has no side doors.

**D35. Orders log = append-only `orders.log` events.** Each records the originating message, the action, the summary, links and the inverse. Undo runs the inverse and appends a new entry with `reverses`; a second undo is refused. Some changes have no inverse (deploy rights; withdrawing a mission) and say so instead of offering Undo. Undoing a mission order withdraws it (`withdrawn` mission status, backbrief rejected, tasks stood down).

**D36. Orders reach live work in two ways.** Running bots get a recorded `frago` that `TaskRunner` delivers into the run (`RunContext.waitForFrago`), and they re-read live orders with `RunContext.orders()`. Blocked tasks whose block reason shares at least two significant words with what changed are restarted by the Overseer (with a unit sitrep). New tasks pick up changes from their brief.

**D37. A rule change replaces only the best-matching order.** "Stop blocking on low-severity findings" removes the standing order that best matches it, not every order that mentions findings. Ties are removed together.

**D38. Musings and irreversible orders are held as `pending.action` events.** Musings get "Yes, do it" / "No"; irreversible kinds (the setting `irreversibleActions`, default `grant-deploy-rights`) need the typed phrase (setting `confirmationPhrase`, default "confirm"). Answers are `pending.resolved` events. Settings are a versioned `settings` entity.

**D39. Cross-unit orders are relayed by HQ.** An order naming another unit runs against that unit, is logged with `routedVia: 'hq'`, and HQ posts it into the other unit's channel. The full HQ (planning, routing, shared record) comes in Phase 4.

**D40. Production deploy rights are given only by order in chat.** The Supply Depot screen lists production environments but issues them only through chat, where the irreversible-order confirmation lives.

**D41. Toasts live in the CDK overlay container.** When a dialog (chat drawer, palette) is open, CDK hides everything outside the overlay container from assistive tech; toasts must stay announced and clickable, so the outlet moves itself there.

**D42. The chat history is a plain scrolling log, not virtual-scrolled.** Messages vary a lot in height (read-back cards), the view loads the last 500 per channel, and full history is in the record and Archive. Virtual scroll stays on the fixed-row feeds (working record, War Diary, sitreps).

**D43. Docs mirror writes are serialized per repository.** Units that share a repository share its `orbot/unit-docs` worktree, so `GitDocumentStore` runs one git operation at a time per repository.

## Phase 4

**D44. HQ is a service, not a bot.** `HqService` runs operations as `system:hq`; its staff work (planning, after-action) goes through the default runtime's `planOperation` / `afterAction`, so it stays runtime-agnostic and works offline.

**D45. One integration branch per operation.** `orbot/op-<id8>` is cut from the repository's default branch. Every task in the operation starts from it (`baseRef`); finished work and fix tasks are merged back in, so each unit receives exactly what the previous one delivered. Branches and worktrees are never removed.

**D46. Missions in an operation form a chain.** The plan creates build → inspect → guard → deploy missions linked by `dependsOnMissionId`. Downstream missions sit in `waiting` until the upstream mission hands off. Units brief back before execution, and execution starts only when every backbrief is approved.

**D47. A send-back is a task stood down with "Sent back: …".** HQ turns it into a fix task in the upstream unit, preferring a bot that is free. The downstream mission waits, and the sent-back task is re-queued when the fix is integrated. In simulation, `inspect-strict` always sends back once and adds a handover flag aimed at Engineers, so the loop is exercised every time.

**D48. Production deploys need two things.** The Commander's approval on the deploy task (shown inline on Approvals and the operation page; skipped only when the unit's gate is escalations-only), and production deploy rights for the unit, which are given only by order in chat (D40). Without rights the deploy task blocks, and granting them resumes it.

**D49. After Action review lessons become standing orders automatically.** The AAR is written as a document; each lesson becomes a standing order in the unit it names (or every unit in the operation), as a new unit version attributed to `system:hq` with the review as its reason, so the Commander can see and revise it. Cross-unit lessons (handover flags naming another unit) are posted as HQ sitreps and land in the operation's shared record document.

**D50. ClaudeRuntime is a manual tool loop on the Messages API, not the Agent SDK.** ORBOT must own every side effect: file access is confined to the task worktree, scripts are limited to `npm run`, commits go through git, and every tool call becomes a record event via `RunContext`. No tool returns a secret value. A handover is required before any terminal tool (done/blocked/failed/send_back/stand_down). Overseer and HQ calls use structured outputs (zod), validated again by ORBOT. Server-side fallback is enabled. The runtime is registered only when `ANTHROPIC_API_KEY` is set, and the key is added to the redactor.

**D51. Bots can be switched between runtimes** (`PUT /bots/:id/runtime`, a select on the bot page with Undo). The choice is a versioned field on the bot.

**D52. Launching an operation from chat has no inverse.** Withdrawing a whole operation is done by standing its units down (Phase 5), not by Undo.

## Phase 5

**D53. Stand down is an order on a target, not a status.** A `halt` field (`reason`, `by`, `at`) on a bot or a unit, or on settings for "everything". Each is a versioned change with who and why; lifting it is another version. Bot and task statuses stay what they are: a halted bot is idle, and its paused task is `stood-down` with the reason "Stood down by order: …". Lifting an order resumes exactly those tasks. (The older "stood-down" bot status still means retired by replacement.)

**D54. Work pauses with a handover even if the bot doesn't write one.** `TaskRunner.stop` aborts the run. If the bot left no handover this run, ORBOT writes one from the run's own record: the last steps, the branch to pick up from, and a flag to check uncommitted changes. The paused task's next brief carries it, as for any successor.

**D55. Three layers keep halted work halted.** The Overseer's dispatcher skips halted units and bots. `TaskRunner.start` asks the policy hook (`task.start`), and the `Stand down` policy rule refuses it, with the refusal on the record. The same rule refuses every bot event mid-run, so a run caught between the order and the abort finishes as stood down, not blocked.

**D56. Stand down by chat is reversible.** `stand-down` and `lift-stand-down` are each other's inverse in the orders log. "Stand down" with no particular work named halts the addressed unit; "everyone/everything" halts all units; a callsign halts that bot. "Stand down the mobile layout" is still a frago on that work. HQ planning and Overseer backbriefs continue during a stand-down: it stops work, not thinking.

**D57. The banner is the single place to see every order in force.** It shows on every screen, with a Resume button per order. The header has "Stand down all units" (it asks for a reason). Unit and bot pages have their own Stand down / Resume. Each action gives an Undo toast.

**D58. Budget caps: three levels, one source of truth.** A unit's cap is its existing `computeBudget` (0 means no cap; the seed gives each unit 100). An operation's cap is `budgetUnits`, set when stating intent or on the operation page. A task's cap is its own `budget.limitUnits`. Spend is always the sum of `cost` events in the record (by unit, operation or task), never a counter kept on the side.

**D59. The cost is recorded first, then the run stops.** A bot reports a cost after spending it, so ORBOT never refuses to record a cost. Right after each cost, `TaskRunner` asks the policy hook (`task.continue`). At a cap, the `Budget cap` rule refuses, and the task is blocked with "Held by policy: Compute budget cap reached: …". So a unit can end slightly over its cap, by at most one bot step. The same rule refuses `task.start` at a cap.

**D60. The warning fires once per crossing.** When a cost takes spend across the warning share (setting `budgetWarnAt`, default 80%), ORBOT writes a `budget.warning` event and a unit sitrep. While spend stays at or above the share (and at the cap), the ORBAT, Approvals and the operation page show a Needs-you item.

**D61. Raising a cap releases exactly the work it held.** Setting a cap (unit page, operation page, or in chat: "Give Engineers 20 more compute budget") restarts blocked tasks whose reason is the budget cap, in that unit or operation. Each restart goes through the policy check again, so work still over another cap stays held. A `budget.set` event records the change and the tasks it released. A simulated bot picking up held work skips a commit it already made.

**D62. Escalation climbs a fixed chain: Overseer → HQ → Commander.** Each level's step is an `escalation` event (same `chainId`): what that level saw and what it did, plus a sitrep at Overseer and HQ level. The Commander's step stays open as a Needs-you item, with Acknowledge, until the work moves on (the task is picked up again or done, or the stood-down bot resumes) or the Commander acknowledges it. Closing it is an `escalation.resolved` event.

**D63. What counts as stuck, and what the Overseer does first** (thresholds are settings):

- **Stall:** no entry on the task's record for `stallSeconds`. The Overseer first sends a status-check frago. Still silent for another `stallSeconds`, it stops the run (paused with a handover) and escalates.
- **Timeout:** one run longer than `timeoutSeconds`. It is stopped with a handover and escalated.
- **Repeated failure:** a task that has failed `repeatedFailures` times is not retried. It is escalated, and the escalation replaces the plain "failed" item for that task.
- **Failing bot:** a bot whose last `failingBotRuns` runs all failed is stood down by its Overseer and escalated.

A single failure is not an escalation: it already shows as a failed task, and a failure is usually a judgement that needs the Commander anyway. The sweep runs every `ORBOT_ESCALATION_SWEEP_SECONDS` (tests call it directly).

**D64. HQ has no remedy of its own yet.** It records that it saw the escalation and raises it to the Commander. Moving work to another unit is left for later (Deconfliction / Main Effort).

**D65. Deconfliction: the map comes from git, the notices go on the record.** Each task already has its own worktree and branch (`orbot/task-<n>`). "Who touches what" is worked out from git on demand: the files each active task (queued, working, blocked, stood-down, awaiting approval) changes since it branched, committed or not. ORBOT's own per-task notes under `orbot/` are left out. Nothing is cached that could drift from the branches.

**D66. HQ informs; it does not block.** When a task writes or commits a file that another active task in the same repository is also changing, HQ records one `deconfliction` notice per pair of tasks (and per new file), posts an HQ sitrep, and sends both running bots a frago naming the other task. Both keep working: whichever lands second rebases. Tasks in the same operation are not flagged against each other, because they land in order on the operation's integration branch.

**D67. Separation of duties is enforced where every write lands, not at each door.** `RecordService` runs write guards before any entity version is stored. `DutiesService` registers one: if the actor is a bot, it refuses the bot doing any of these to itself or its own unit, by whatever path the write comes:

- approving a backbrief or a production deploy (its own work, or its own unit's);
- changing its own unit's standing orders, ROE or approval gate;
- adding supply, budget or credentials to itself or its unit;
- lifting a stand-down that covers it.

The refusal is a policy decision on the record ("Separation of duties: …", action `duty:<kind>`), and the write is rolled back. The Commander, HQ and other system actors are not bots and are not limited by this. Bots acting on other units are not "their own" and are left to the other rules.

**D68. On "escalations only", HQ approves plans on the Commander's behalf.** Before, the Overseer that wrote the plan also approved it. Now `system:hq` does, so no bot approves its own work. The Commander still sees every approval on the record.

**D69. Disputes are raised by bots about their own task, and the task waits.** A `dispute` bot event (a scenario step, or the ClaudeRuntime `raise_dispute` tool) names the other unit and states the claim. The task blocks ("Disputed with Guard: …"), and a versioned `dispute` entity opens.

**D70. HQ rules only under standing orders.** `BotRuntime.ruleDispute` decides who prevails and cites the orders that settle it. ORBOT keeps only citations of orders that really exist on the two units, and a ruling without one is treated as no ruling. If an order settles it, the ruling takes effect at once: the task resumes with the ruling in its brief (`TaskBrief.rulings`) and the bot follows it. If none does, HQ refers it to the Commander (a Needs-you item) and the task stays blocked.

**D71. The Commander has final say over any dispute.** The Commander can rule on a referred dispute, or uphold or overturn an HQ ruling. That ruling is final: a second ruling is refused, and the way to change course is a new order. An overturn reaches the work in progress: a blocked task resumes with the final ruling, and a running one gets a frago. If the work is already done, the ruling is on the record, and acting on it is a new order.

**D72. Links from the API keep their fragments.** Attention links like `/disputes#dispute-…` go through a `url` pipe (Router.parseUrl) so `routerLink` doesn't encode the `#`. This also fixes the backbrief links in Needs you.
