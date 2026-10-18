# Plan: command improvements (items 2–6)

Item 1 (rules of engagement briefed and enforced through permission requests) is built: see D98.
This plan covers the rest, in the order we recommend building them. Each item lists what changes,
where, and the automated test that marks it done (CLAUDE.md: each "done when" is a test).

All five follow the existing rules: entity changes go through `RecordService.revise()` with an
actor and a reason. Chat gets a `ChatAction` kind with an executor that returns its inverse.
Limits on bots go in the policy layer. Nothing is deleted.

---

## 2. Change an operation after the O Group

**Why:** after planning, an operation can only take a new budget or be named the main effort.
You can't refine the intent, add or drop a stage, or call the whole thing off.

**What changes**

- `OperationPhase` gains `cancelled` (terminal, like `closed`).
- `HqService`:
  - `amendIntent(opId, intent, reason, actor)`: a new version of the operation. Missions that
    haven't started (`planning`, `awaiting-approval`, `waiting`) are re-planned with
    `staff.planOperation`, given the current state (missions done so far stay as they are).
    Missions already `working` get a frago with the new intent. Their backbriefs go back to
    `awaiting-approval` (round + 1) with the change as a Commander note.
  - `addMission(opId, { unitId, stage, goal, definitionOfDone }, actor)`: inserted into the
    chain at its stage; `dependsOnMissionId` of the next mission is re-pointed (a revision, not
    an edit).
  - `withdrawMission` already exists in chat (`withdraw-mission`). Make it operation-aware: the
    downstream mission depends on the withdrawn one's upstream, so the chain stays joined.
  - `cancel(opId, reason, actor)`: every open mission is withdrawn. Running tasks stand down
    with a handover (`StandDownService` path). The integration branch is kept, and the phase
    becomes `cancelled`. An After Action review still runs (lessons from a cancelled operation
    are the most valuable).
- Routes on `OperationsController`: `PUT operations/:id/intent`, `POST operations/:id/missions`,
  `POST operations/:id/cancel`. All are the Commander's alone (no `@Authority`).
- Chat: `amend-operation`, `add-mission` (inverse: `withdraw-mission`), `cancel-operation`
  (irreversible by default: add it to `DEFAULT_SETTINGS.irreversibleActions`), and
  `operation-budget` (inverse: the previous cap). These four are COMMANDER_ONLY in
  `chat.service.ts`.
- Interpreter (`simulated-interpreter.ts` + `claude-common.ts` interpret prompt): add the
  operation id/phase to `InterpretInput.operations` (already there) so these can target an
  operation by name.
- Web, `features/operations/operation.page.ts`: "Amend intent", "Add mission" and
  "Cancel operation…" (confirmation dialog), hidden with `*orbCan` for non-Commanders.
- `SandTableService` rehearses again after any of these changes.

**Done when** `test/operation-changes.e2e-spec.ts` passes:

- Amending the intent re-plans unstarted missions and sends running ones a frago.
- Added and withdrawn missions keep the chain joined.
- Cancelling stands work down with handovers, keeps every document, and still produces an
  After Action review.
- Each change is on the record with its reason, and the chat forms work with undo where there
  is an inverse.

---

## 3. A finer approval matrix per unit

**Why:** three gate presets do several jobs at once. `escalations-only` both auto-approves
backbriefs and skips production deploy approval, which is surprising for Inspection.

**What changes**

- `UnitBody.approvals` (zod, `.default(...)` derived from the old `approvalGate`, so existing
  versions read correctly): it has `backbrief`, `productionDeploy`, `sendBack` and
  `spendOver: number | null`. Each is `'commander' | 'captain' | 'none'` (who must approve).
  `approvalGate` stays readable for history but is no longer written. The migration is a
  schema default plus a one-off `revise` by `system:migrate` (append-only).
- `OverseerService` lines that read `approvalGate` (`autoApprove`, `deployNeedsApproval`) read
  the matrix instead. A new policy rule holds a task whose next `cost` would cross
  `spendOver` until approved (reusing the permission-request path from D98:
  `permission.requested` with `rule: 'spend over N units'`).
- `DutiesService`: changing `approvals` is `change-own-rules`, like `approvalGate`.
- Chat `rule-change` gains `approvals` fields. The web rules tab shows the matrix as a small
  table (edit is Commander-only).

**Done when** `test/approval-matrix.e2e-spec.ts` passes: each cell changes behaviour
independently, old units read with the equivalent matrix, and a bot cannot change its own
matrix.

---

## 4. Approve HQ's plan before missions are cut

**Why:** you approve each unit's backbrief, but never HQ's split of the intent across units.

**What changes**

- `OperationBody.plan`: `{ status: 'awaiting-approval' | 'approved' | 'rejected', missions:
OperationPlan['missions'], round, notes[] } | null`.
- `HqService.oGroup` stores the plan instead of creating missions. It creates missions only
  once the plan is approved, unless settings say `planApproval: 'auto'` (default `'commander'`;
  `'auto'` keeps today's behaviour for tests and solo use).
- `POST operations/:id/plan/approve | amend | reject`, mirroring backbriefs:
  - amend replaces the mission list
  - reject re-plans with the note, as round + 1
- `ViewsService.approvals()` adds a plan item to Needs you, and `AlertService` alerts on it.
  The sand table runs on the proposed plan (it already rehearses from missions; give it a
  "proposed" input).
- Chat: `approve-plan` (with an optional note).

**Done when** `test/plan-approval.e2e-spec.ts` passes: no mission exists until the plan is
approved, amend and reject loop correctly, and the setting `auto` gives today's behaviour.

---

## 5. A configurable stage chain

**Why:** build → inspect → guard → deploy is fixed. A docs change or hotfix may skip stages, and
inspect and guard could run side by side.

**What changes**

- `MissionBody.dependsOnMissionIds: Id[]` (default from `dependsOnMissionId`), so a mission can
  wait on several upstream missions. Keep `dependsOnMissionId` readable.
- `OperationPlan.missions[]` gains `after: number[]` (indices of the missions it follows).
  `planOperation` instructions allow skipping stages and running inspect and guard in parallel
  when the intent warrants it. The simulated overseer gains a "docs-only" plan.
- `HqService.missionDone` hands off when **all** of a mission's upstream missions are done.
  Integration merges each upstream's branch in turn (the integration branch is already shared,
  and conflicts surface through `DeconflictionService`). A send-back goes to the upstream
  mission that owns the files (the deconfliction map), else to the build mission.
- `SandTableService` checks the graph: no cycles, and one deploy at the end at most.
- Operation page: the chain is drawn as a small graph (inline SVG; tokens only).

**Done when** `test/stage-graph.e2e-spec.ts` passes:

- A two-stage operation (build → deploy) runs.
- Inspect and guard run in parallel and both must pass before deploy.
- A send-back from either goes to build.
- The sand table flags a cycle.

---

## 6. A definition of done for operations

**Why:** missions have one, operations only free-text intent. The After Action review has
nothing to measure against.

**What changes**

- `OperationBody.successCriteria: string[]` (default `[]`).
  - `CreateOperationRequest` and chat `create-operation` take an optional list.
  - HQ drafts criteria from the intent when none are given, shown in the plan (item 4) for
    approval.
- `planOperation` input includes the criteria. Each mission's definition of done must trace to
  at least one criterion (the sand table flags criteria no mission covers).
- `afterAction` input gets the criteria. `AfterActionReview` gains
  `criteria: { text, met: boolean, evidence }[]`, rendered in the After Action document.
- Operation page and daily brief show criteria with `<orb-status>`.

**Done when** `test/operation-criteria.e2e-spec.ts` passes: criteria flow from creation to plan
to the After Action review, uncovered criteria are flagged on the sand table, and the review
reports each criterion as met or not.

---

## Order and dependencies

1. **2** (operation changes) stands alone.
2. **6** (criteria) is small, and **4** builds on it.
3. **4** (plan approval) gives **5** a place to show the stage graph before it runs.
4. **5** (stage graph) is the largest change: it touches handoff and integration.
5. **3** (approval matrix) can go any time after D98, since it reuses permission requests for
   `spendOver`.
