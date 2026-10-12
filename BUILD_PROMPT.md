You are building a web app from the design below. Work in phases, stop at the end of each phase for my review, and do not start the next phase until I say so. Before writing any code, enter plan mode, read this whole prompt, and show me your plan for Phase 1 plus the repo structure.

# 1. What we're building

A web app that lets one person command teams of software-development bots the way an officer commands units: state intent, issue orders, read reports. The product is named **ORBOT**. Keep the name in one config value so it can be changed later.

Five principles override everything else. If any implementation choice conflicts with one of these, the principle wins:

1. **Chain of command.** Commander (me) → HQ → Units → Bots. Each unit's Overseer directs its own bots. Orders flow down, reports flow up.
2. **Chat is command.** An order given in chat changes the system, not only the conversation.
3. **Knowledge belongs to the unit, never the bot.** Any bot can be replaced and its successor continues from the unit's documents alone.
4. **Nothing is ever deleted.** Every document, chat, and log is kept. A rewrite creates a new version and archives the old one.
5. **Secrets stay out of every record.** Passwords and keys never appear in any document, log, chat record, archive, API response, or error message.

# 2. Tech stack

- **Monorepo** with npm workspaces (or Nx if you judge it clearly better): `apps/api`, `apps/web`, `packages/shared` (shared TypeScript types, DTOs, enums, zod schemas).
- **Backend:** Node.js (current LTS), TypeScript strict mode, **NestJS**. REST for commands/queries, **WebSockets (Socket.IO via Nest gateway)** for live sitreps, status changes, and chat streaming.
- **Database:** PostgreSQL via Docker Compose. Use Prisma or Drizzle (your call; justify it in the plan). The record is **append-only** — enforce it in the data layer, not just by convention (see §6).
- **Secrets store:** physically separate from the record — a separate encrypted table/database or file, encrypted at rest with a key from an environment variable. Referenced everywhere else by name only.
- **Frontend:** latest stable **Angular**, standalone components, **signals** for state, the new control flow (`@if`, `@for`), lazy-loaded routes, OnPush everywhere. Use **Angular CDK** for overlays, a11y, drag-drop, and virtual scroll. Build a small in-house component library on top of it (don't use a heavy UI kit whose look would fight the design in §8). Tailwind or SCSS with CSS custom properties for design tokens — your call.
- **Bot runtime:** all bot work goes through a `BotRuntime` interface. The rest of the app (Overseers, record, chat, UI) only talks to that interface and never knows which runtime is behind it, so the AI model can be swapped without rewrites. Ship two adapters:
  - `SimulatedRuntime` — scripted, deterministic fake bots with no AI calls. Given a task, a simulated bot waits briefly, writes plausible War Diary entries, sitreps, and a handover, and sometimes gets blocked or fails on purpose (driven by scenario config, so a given scenario always plays out the same way). It drives all development, demos, seed data, and automated tests, and costs nothing to run. It proves the command system works, not code quality.
  - `ClaudeRuntime` — uses the Anthropic API / Claude Agent SDK to run a real bot in an isolated workspace (git worktree or container) against a connected repo. Model name is config.
- **Testing:** unit tests (Jest/Vitest), API e2e tests, and **Playwright** for UI flows. Each phase's "done when" test must be an automated test.
- **Dev experience:** `docker compose up` + one command starts everything. Seed script creates a demo force (4 units, ~3 bots each, one operation in flight) using the simulated runtime so the UI is never empty in dev.
- Create a `CLAUDE.md` at the repo root capturing conventions, commands, and these principles, and keep it updated.

# 3. Domain model

Core objects (define in `packages/shared`):

- **Commander** (single user for now; design auth so more users with ranks can be added later).
- **HQ** — the planning layer.
- **Unit** — name, role, standing mission, Overseer, bots, supply, standing orders, rules of engagement, documents.
  - Seed units: **Engineers** (developers — build features and fix bugs to spec), **Logistics** (DevOps — keep pipelines, environments, deployments running), **Inspection** (QA — nothing moves forward untested), **Guard** (security — nothing ships with a known vulnerability). Units must be data, not hard-coded, so Intel or Medics can be added later.
- **Overseer** — the bot that commands a unit.
- **Bot** — belongs to one unit; has a role, current task, queue, status (idle, working, blocked, failed, stood down).
- **Operation** (owned by HQ) → **Mission** (owned by an Overseer, has goal + definition of done) → **Task** (owned by one bot). Every piece of work belongs to exactly one unit or one bot.
- **Operation lifecycle:** Intent → O Group → Backbrief → Execution → Handoffs → Sitreps → Frago (any time) → After Action. Model as an explicit state machine.
- **Handoffs:** Engineers → Inspection → Guard → Logistics. A failed check sends work back to the previous unit with the reason.
- **Supply** — repos, environments, tools, credential *references*, compute budget; allotted per unit or per operation from a **Supply Depot** (only what I've connected exists).
- **Standing orders** — rules that always apply to a unit.
- **Rules of engagement** — what a bot may do alone vs. must escalate.
- **Unit documents** — Field Manual (curated by Overseer), War Diary (auto-written as bots work), Handover notes (each bot at the end of every task), Standing orders.
- **Orders log** — every change made from chat, with the message that caused it.
- **Sitrep, Backbrief, Frago, After Action review, Approval/Escalation** — first-class records.

# 4. Command by chat

I can chat with HQ or any Overseer. The Overseer classifies each message into one or more of:

| Kind | Example | Effect |
|---|---|---|
| Question | "How far along is the login work?" | Answered; nothing changes |
| Order | "Add rate limiting to the API." | New task or mission created |
| Frago | "Drop the mobile layout for now." | Work in progress is changed |
| Rule change | "Stop blocking on low-severity findings." | Standing orders / ROE edited |
| Supply grant | "I'll give you access to the payments repo." | Access, tools, or budget added |

Implementation rules:

- Classification produces **structured actions** (typed, validated with zod), never free-text side effects. Actions execute through the same service layer the UI uses.
- After acting, the Overseer posts a **read-back**: "Wilco. Low-severity findings no longer block. Payments repo access granted to Guard." Render it as a structured card listing each change, with a link to each changed object and an **Undo** that issues a reversing entry (never a delete).
- **Orders log:** every chat-caused change is recorded with the originating message and is reversible by a new entry.
- **Rules apply to live work:** a rule change applies to new tasks immediately, and the Overseer issues a frago to any bot whose current task is affected.
- **Supply comes from the depot:** if I promise something that isn't connected, the Overseer says exactly what's missing and offers to open the connection screen.
- **Cross-unit orders route through HQ** so the other Overseer is informed; show this routing in the read-back.
- **Musing is not ordering:** "I might give you more budget" changes nothing; the Overseer asks whether I meant it as an order, with one-click "Yes, do it" / "No".
- **Irreversible orders** (e.g. production deploy rights): ask for a one-line confirmation before executing (see §10).
- With the simulated runtime, implement classification with a rules/keyword classifier so chat works offline; with the Claude runtime, use the model with tool/function calling to emit the structured actions.

# 5. Unit knowledge and learning loop

Every bot is treated as a replacement arriving on day one. For every task:

1. **Before:** brief the bot with the last handover for that work, relevant Field Manual sections, and recent War Diary entries. It can search everything else on demand (active first, archive as fallback).
2. **During:** it logs decisions and surprises to the War Diary.
3. **After:** it writes a handover (state, next steps, what was tried and failed, open problems, flags for a successor).
4. **Overseer curates:** promotes lasting lessons from handovers into the Field Manual (with provenance links), merges duplicates, retires outdated entries to the archive.

Lessons that matter to other units go up to HQ into a shared operation record. I can read and edit any unit's documents, and a correction in chat updates them.

**Cold-start check:** the Overseer periodically gives a fresh bot only the unit's documents and checks whether it could continue the work; gaps become Field Manual fixes. Show the latest result on the unit view.

**Storage of unit documents:** Markdown files in the project's repository, mirrored into the record (see §10). Put the storage behind an interface so it could move later.

# 6. The permanent record

- **Two tiers:** Active (current version of everything; bots are briefed from it) and Archive (every prior version, read-only, permanent).
- **Append-only enforcement:** no UPDATE or DELETE on record tables. A rewrite inserts a new version; the old one is stamped with superseded-at, superseded-by (who), and reason, and links to its replacement. Enforce with DB permissions or triggers, and add a test that proves an UPDATE/DELETE fails. My own edits follow the same rule.
- **Kept:** every version of every Field Manual, standing order, and rule; the full War Diary and every handover; every chat and the orders log; every sitrep, backbrief, frago, and After Action review; each bot's per-task working record (what it did, tried, and produced).
- **Retrieval:** view any document as it stood on any past date with diffs between versions; full-text search (Postgres FTS is fine) across active by default, archive on demand; provenance links from Field Manual entries to source handover/diary entries.
- **Secrets:** stored only in the secrets store. A **redaction layer** sits in front of every write to the record, every log line, and every API response, and blocks/masks anything that looks like a secret value. Bots record that a credential was used (by name), never its value. Add tests that try to leak a secret through chat, diary, handover, logs, and errors.

# 7. Screens

| Screen | What it shows |
|---|---|
| **ORBAT** (home) | Every unit: Overseer, bot count, current mission, status, anything needing my attention |
| Operations board | Active operations and progress by mission |
| Unit view | Objective, progress, Overseer, queue, what each bot is doing, documents, supply, rules |
| Bot view | Current task, queue, recent history, working record |
| Chat | Conversation with HQ or any Overseer |
| Sitrep feed | Reports from bots and units, filterable by level |
| Approvals | Backbriefs and escalations waiting on me |
| Archive | History and search across the permanent record |

Blocked bots, failed tasks, and backbriefs awaiting approval surface **on the ORBAT itself** so I only click into a unit when something needs me.

# 8. UX and UI requirements — treat these as seriously as the backend

The bar is: a new user can find anything within two clicks of the ORBAT, never wonders where they are, and never wonders whether an order took effect.

**Navigation and orientation**
- Persistent left rail: ORBAT, Operations, Approvals (with badge count), Sitreps, Archive, Settings. Collapsible.
- **Breadcrumbs that mirror the chain of command**: `ORBAT › Engineers › Bot E-3 › Task #142`. Every object is one click from its parent.
- **Deep-linkable everything** — every unit, bot, task, document version, chat message, and orders-log entry has a stable URL. Back button always works.
- **Command palette (Ctrl/Cmd+K)**: jump to any unit/bot/operation/document, run common actions ("New operation", "Chat with Guard", "Stand down…"), and search the record.
- **Chat is always one keystroke away**: a slide-over chat drawer available from any screen, pre-targeted to the Overseer of whatever I'm looking at. Full-page chat also exists.
- Keyboard shortcuts for the main screens (`g o` ORBAT, `g a` Approvals, etc.) with a `?` cheat-sheet overlay.

**Attention first**
- The ORBAT is a dashboard of unit cards (or a tree view toggle). Each card shows status at a glance and an **attention strip** listing what needs me, each item one click from resolution.
- A global **"Needs you" counter** in the header that opens a single inbox of approvals, escalations, musing-clarifications, and irreversible-order confirmations.
- Approve/amend backbriefs **inline** wherever they appear, not only on the Approvals screen.

**Status language**
- One consistent status system across the app: color + icon + text label (never color alone). Same vocabulary everywhere (Working, Blocked, Failed, Awaiting approval, Stood down, Done).
- Live updates via WebSocket with subtle transitions — no full-page reloads, no layout jumps.

**Trust and feedback**
- Every chat-caused change gets the read-back card with links and Undo (§4). Every UI-caused change gets a toast with Undo where reversible.
- Optimistic UI where safe, with clear rollback on failure.
- Errors say what happened and what to do next — never a raw stack trace.

**Military vocabulary without the learning curve**
- Every military term (Frago, Sitrep, Backbrief, O Group, ORBAT, Wilco, etc.) has a **glossary tooltip** on hover/focus, sourced from one glossary file.
- Empty states explain what the screen is for and offer the first action ("No operations yet — state your intent to launch one").

**History and the archive**
- On any document: a "History" tab with a version timeline, side-by-side diff, and a date picker to view it as of any past date. Superseded versions are clearly marked with who/when/why and a link forward.
- Archive search shows results grouped by type with filters (unit, type, date range, active vs. archived).

**Visual design**
- Calm, dense-but-readable "operations room" aesthetic: dark mode by default with an equally polished light mode, restrained accent color, clear typographic hierarchy, generous use of whitespace in detail views, tighter density in lists and feeds.
- Design tokens (colors, spacing, type scale, radii, shadows) as CSS custom properties; no hard-coded values in components.
- Skeleton loaders, not spinners, for page loads. Virtual scrolling for long feeds and diaries.
- Responsive: fully usable on a laptop; ORBAT, Approvals, Sitreps, and Chat must work well on a phone.

**Accessibility**
- WCAG 2.2 AA: full keyboard navigation, visible focus, correct ARIA via CDK a11y, sufficient contrast in both themes, reduced-motion support. Add automated axe checks to the Playwright suite.

# 9. Build plan — stop after each phase

Each phase ends with an automated test proving it works. Show me the test passing and a short demo walkthrough (what to click) before moving on.

**Phase 1 — Foundation: the record and one bot**
- Repo scaffolding, Docker Compose, CI script, CLAUDE.md, design tokens and app shell (left rail, breadcrumbs, theme toggle, empty states).
- The permanent record first: append-only versioned storage, archive, history, diff, search, redaction layer.
- Separate secrets store.
- Core objects: units, bots, operations, missions, tasks.
- `BotRuntime` interface + `SimulatedRuntime`; connect one repository and run a single bot on a single task in its own workspace.
- *Done when:* one bot completes one task and every step it took can be found in the record; UPDATE/DELETE on the record is proven to fail; secret-leak tests pass.

**Phase 2 — One unit under command**
- Engineers Overseer with task queue, backbriefs, sitreps.
- Field Manual, War Diary, handover notes, and pre-task briefing.
- ORBAT, Unit view, Bot view, Approvals (inline backbrief approval), command palette, glossary tooltips.
- *Done when:* a fresh bot finishes another bot's half-done task using only the unit's documents.

**Phase 3 — Command by chat**
- Chat with the Overseer (drawer + full page), message classification into the five kinds, structured actions, read-back cards with Undo, orders log, supply depot, musing detection, irreversible-order confirmation.
- *Done when:* a rule change and a supply grant given in chat take effect on live work with no other input from me.

**Phase 4 — The full force**
- HQ, operations split into missions across units, the operation state machine.
- Logistics, Inspection, Guard with handoffs and send-backs.
- Operations board, shared cross-unit record, chat with HQ, After Action reviews that save lessons as standing orders, cross-unit order routing via HQ.
- `ClaudeRuntime` adapter working end-to-end against a real repo.
- *Done when:* one operation runs from my statement of intent to a deployment across all four units (automated with SimulatedRuntime; manually demonstrated with ClaudeRuntime).

**Phase 5 — Nice-to-haves** (one at a time; ask me which next)
- First, in this order: **Stand down** (halt a bot, unit, or everything; work pauses with a handover so it can resume), **Budget caps** (hard limit per unit/operation with warning), **Escalation for stuck work** (stalls, repeated failures, timeouts go up the chain), **Deconfliction** (own workspace + branch per task; HQ tracks who touches what), **Separation of duties** (a bot can't approve its own work, change its own rules, or grant itself supply), **Disputes** (HQ rules under standing orders; I have final say).
- Then: Main Effort, Recon, Sand Table, Daily brief (with phone alerts), Service record, Other officers (multi-user with ranks), Connections (code host, issue tracker, build pipeline).

Even though stand down, budget caps, and separation of duties are Phase 5, design the data model and service layer from Phase 1 so they slot in without rewrites (e.g. every bot action passes through a policy check hook, every task has a budget field).

# 10. Settled decisions

These are decided. Build to them, and make each one a setting so it can be changed later without code changes.

- **Approval gates:** I approve every backbrief (each unit's plan) and every production deploy. Everything else proceeds without me and only reaches me when escalated. Configurable per unit, from "approve everything" to "escalations only".
- **Irreversible orders in chat:** actions that can't be undone (e.g. granting production deploy rights) ask for a one-line confirmation before executing. Everything else executes on my word.
- **Overseers:** every Overseer is a bot. Keep the model flexible enough that a human Overseer could be added later, but don't build that now.
- **Bot model/tooling:** `SimulatedRuntime` for development and tests; `ClaudeRuntime` (Anthropic API / Claude Agent SDK) for real work from Phase 4. Model name is config.
- **Unit documents:** Markdown files in the project's own repository (versioned with the code, readable by human developers), mirrored into the record for history and search. Chats, logs, sitreps, and the orders log live in the Postgres archive.
- **Project name:** ORBOT, stored in one config value. Keep it visually distinct from the ORBAT home screen (e.g. product name in the header, "ORBAT" only as the screen title).

# 11. How to work

- Plan before each phase; keep commits small and descriptive.
- Write tests alongside code, not after.
- When the design is ambiguous, pick the option most consistent with the five principles, note it in `docs/decisions.md`, and keep going — only stop to ask me when a choice would be expensive to reverse.
- At the end of each phase, give me: what was built, how to run it, what to click to see it, test results, and any decisions you made.
