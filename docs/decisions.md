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
