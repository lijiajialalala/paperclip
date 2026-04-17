# Paperclip Runtime System Architecture

Status: Draft  
Date: 2026-04-16  
Audience: runtime/control-plane maintainers, backend engineers, operators designing execution policy

## 1. Why this document exists

Paperclip has accumulated several runtime-related capabilities that each make sense on their own:

- heartbeat-based agent execution
- issue-scoped execution locking
- work-plan approvals
- execution workspace realization
- runtime service management
- issue status truth and repair
- QA / platform writeback

The current problems are not mainly caused by one bad function. They come from a deeper issue:

`heartbeat`, `issues`, `approvals`, `execution_workspaces`, and `workspace_runtime_services` are now jointly expressing "what may run, what is running, what is review-blocked, and what is safe to close", but there is no single authoritative state machine that all layers obey.

That is why the system can look individually reasonable while still produce systemic contradictions:

- historical skill docs said proposing a plan transitions an issue to `in_review`, while the route did not do that
- the issue approval route historically required `in_review`, even though the write path that should produce `in_review` no longer existed
- approval inbox resolution could still approve the plan, so the system was partially recoverable through a different path
- shared constants forbid manually writing `in_review`, which makes the deadlock harder to repair
- old runtime docs still describe runtime services as manual-only, while `heartbeat` now auto-starts them during execution

This document defines the runtime system as it should be understood now: not as "just heartbeats", but as a mixed control-plane plus execution-plane system.

## 2. Short answer to "why were there so many problems?"

It is not accurate to say the earlier design considered nothing. A better diagnosis is:

1. The system was designed in slices.
2. Each slice introduced a valid local rule.
3. The slices were not re-composed into one end-to-end contract.
4. Tests and docs then locked in different parts of different eras.

The main structural misses were:

- no single authoritative runtime state model across issues, runs, approvals, workspaces, and runtime services
- route-level behavior and shared contracts drifting apart
- user/operator docs describing an older intent after implementation moved on
- business-state gating being split across multiple services instead of being centralized

So the failure mode is not "the code forgot a single edge case". It is "the system has multiple overlapping truths".

## 3. Design goals

The new runtime architecture should optimize for these goals:

1. A single place to answer whether an issue may execute now.
2. A single place to answer which run currently owns execution for an issue.
3. Explicit separation between execution outcome and business approval outcome.
4. Explicit separation between durable runtime objects and derived UI summaries.
5. Durable workspace and runtime-service tracking across process restarts.
6. Safe recovery when a run, service, or child process disappears unexpectedly.
7. Compatibility with both local execution and remote/adapter-managed execution.

## 4. System boundary

The runtime system is not just the adapter runner. It is the set of components that decide, realize, execute, observe, and repair work execution.

It includes:

- agent wakeup ingestion
- queued/run lifecycle management
- issue execution gating
- work-plan approval synchronization
- session continuity
- execution workspace provisioning/reuse
- runtime service provisioning/reuse
- run finalization and deferred promotion
- status truth summarization
- writeback and unblock side effects

It does not include:

- long-term product planning semantics
- general issue/comment CRUD unrelated to execution
- human review policy beyond what must be enforced for execution gating

## 5. Core domain objects

### 5.1 Agent

Represents a worker identity plus adapter/runtime configuration.

Key responsibilities:

- owns adapter type and adapter config
- defines heartbeat policy
- may persist adapter session continuity
- can be paused/terminated/pending approval

Important note:

`agents.status` is not the full runtime truth. It is an operator-facing summary of current agent state.

### 5.2 AgentWakeupRequest

Represents an intent to run.

Current responsibilities:

- records wake source: `timer`, `assignment`, `on_demand`, `automation`
- stores payload/context
- supports coalescing, deferral, skipping, cancellation
- acts as the durable queue precursor before or alongside heartbeat run creation

This object should be treated as the authoritative record of invocation intent, not just telemetry.

### 5.3 HeartbeatRun

Represents one concrete execution attempt.

Current responsibilities:

- durable lifecycle: `queued`, `running`, terminal states
- stores context snapshot, result json, logs, usage, process metadata
- owns adapter invocation and run finalization
- links back to wakeup request

This is the authoritative record of one execution attempt, but not the authoritative record of business completion.

### 5.4 Issue

Represents the planning and ownership unit. It currently also carries much of the runtime gating state.

Important runtime-related fields already on `Issue`:

- `checkoutRunId`
- `executionRunId`
- `executionAgentNameKey`
- `executionLockedAt`
- `planProposedAt`
- `planApprovedAt`
- `executionWorkspaceId`
- `executionWorkspacePreference`
- `executionWorkspaceSettings`
- `statusTruthSummary`
- `runtimeState`
- `qaSummary`
- `platformUnblockSummary`

This is the biggest overloaded object in the system.

### 5.5 Approval

Represents a durable decision request.

In the runtime architecture, the most important current approval type is `work_plan`.

Approvals are the formal control-plane record for:

- who must decide
- whether a plan is pending/approved/rejected
- waking the requester after resolution

### 5.6 ProjectWorkspace

Represents the durable configured root codebase or execution root for a project.

This is the stable anchor.

### 5.7 ExecutionWorkspace

Represents the actual execution environment used by one or more issues/runs.

It exists so the control plane can answer:

- where execution happened
- what branch/worktree/provider backed that execution
- whether a later issue should reuse the same workspace
- what runtime services belong to that execution environment

### 5.8 WorkspaceRuntimeService

Represents a service/process owned or tracked for a workspace scope.

Current design already supports:

- project workspace scope
- execution workspace scope
- run scope
- agent scope

This object is durable and should be treated as the authoritative service inventory, while in-memory registries are runtime caches.

## 6. Authoritative state model

The runtime system needs one rule above all others:

Every state field must be categorized as either:

1. authoritative control state
2. derived summary state
3. convenience cache or UI state

Without this distinction, multiple write paths will continue to conflict.

### 6.1 Recommended authoritative sources

#### Invocation intent

Authoritative object:

- `agent_wakeup_requests`

Why:

- this is the durable record that a run was requested, skipped, deferred, coalesced, or cancelled

#### Concrete execution attempt

Authoritative object:

- `heartbeat_runs`

Why:

- only this object can say one specific execution attempt started, ran, timed out, failed, or succeeded technically

#### Issue execution ownership

Authoritative fields:

- `issues.checkoutRunId`
- `issues.executionRunId`
- `issues.executionAgentNameKey`
- `issues.executionLockedAt`

Why:

- these fields jointly define two different runtime locks that must not be collapsed

Lock split:

- `checkoutRunId` is the assignee-run checkout lease.
- `executionRunId` plus `executionAgentNameKey` plus `executionLockedAt` is the issue-level execution orchestration lock.

Important rule:

- these two locks often coincide on the happy path, but they are not the same concept
- `checkoutRunId` remains authoritative for same-run ownership checks, stale checkout adoption, and checkout conflict repair
- `executionRunId` remains authoritative for cross-agent orchestration, deferral, and active execution ownership
- future refactors must not remove `checkoutRunId` by assuming `executionRunId` is a drop-in replacement

#### Plan approval gate

Authoritative objects:

- `approvals` rows of type `work_plan`
- mirrored issue gate fields `planProposedAt` and `planApprovedAt`

Important rule:

The approval row should be the formal decision record. The issue fields should exist as execution-gate mirrors, not as an independent approval system.

Single-live-selection invariant:

- an issue may have many historical linked `work_plan` approvals
- an issue may have at most one live linked `work_plan` approval at a time
- "live" means an approval that still represents the current unresolved proposal edge for that issue, practically `pending` or `revision_requested`

Selection rule:

- if exactly one live linked `work_plan` approval exists, that row is the authoritative approval truth for the current proposal cycle
- if zero live approvals exist, the issue is either not in a proposal cycle or its mirror fields are stale and need repair
- if more than one live linked `work_plan` approval exists, the system is in ambiguous state and must not silently pick one as truth

Repair rule for legacy ambiguity:

- the control plane should either fail closed with an explicit ambiguity error, or run a deterministic repair that keeps the newest live approval as authoritative and cancels/unlinks older live approvals in the same transactional repair flow
- normal runtime execution gating must not depend on ad hoc list ordering when this invariant is violated

#### Execution location

Authoritative object:

- `execution_workspaces`

Why:

- branch/cwd/provider/status/reuse must survive beyond one run

#### Runtime service inventory

Authoritative object:

- `workspace_runtime_services`

Why:

- services can outlive a single process and must be reconstructed on boot

### 6.2 Derived summaries that must not be treated as source of truth

Derived fields:

- `issues.statusTruthSummary`
- `issues.runtimeState`
- `issues.qaSummary`
- `issues.platformUnblockSummary`
- `agents.status` as a global operator-facing summary

These fields are useful, but they must never become the only input for control-plane decisions if the underlying durable rows disagree.

## 7. End-to-end runtime flow

This is the actual system flow that exists today, expressed as a single architecture.

### 7.1 Wakeup ingestion

Primary entry:

- `heartbeatService().wakeup()`

Flow:

1. Build or enrich wake context.
2. Resolve agent and optional explicit resume session.
3. Enforce budget blocks and agent invokability.
4. If the wake is issue-scoped, enter transactional issue-execution gating.
5. Either:
   - skip
   - coalesce into an existing run
   - defer because another issue execution owner is active
   - create a queued run
6. Publish live event and optionally start next queued run for the agent.

Important architectural property:

`enqueueWakeup` is already much more than queue insertion. It is a policy engine.

### 7.2 Queued-run claiming and execution start

Primary path:

- `startNextQueuedRunForAgent()`
- `executeRun()`

Flow:

1. Select queued runs ordered by age.
2. Claim eligible queued runs.
3. Mark the run active.
4. Load agent, issue context, session state, and workspace policy.
5. Resolve the base workspace.
6. Realize or reuse the execution workspace.
7. Ensure runtime services.
8. Execute the adapter.
9. Finalize run outcome, session continuity, usage, writebacks, lock release, and deferred promotion.

### 7.3 Issue execution gating

Current design intent:

- only one active execution owner per issue
- same-name self-wakes are suppressed
- different agents may be deferred rather than run concurrently on the same issue

This is one of the stronger parts of the current design. The problem is not missing orchestration entirely; the problem is that execution gating and plan approval gating are not unified.

### 7.4 Session continuity

The runtime maintains adapter session continuity per task/session and can also rotate sessions when compaction or reset conditions are met.

This gives the system an important property:

- the execution plane can be heartbeat-based without losing conversational continuity

That is the right model. The issue is not the existence of session reuse. The issue is that session continuity is mixed into the same large service that also owns queueing, workspaces, runtime services, and finalization.

### 7.5 Execution workspace realization

Heartbeat currently resolves and realizes execution workspace inline:

1. determine requested mode from project policy + issue settings + adapter overrides
2. resolve base workspace
3. reuse an existing execution workspace when policy allows
4. otherwise realize a new workspace/worktree
5. persist or update `execution_workspaces`
6. sync `issues.executionWorkspaceId` and related issue settings when needed
7. store workspace metadata back into run context

This is the correct product direction:

- execution workspace is a durable runtime object, not an ephemeral local variable

### 7.6 Runtime service realization

Heartbeat now auto-starts runtime services for run execution when `workspaceRuntime.services` exists in config.

That means the real runtime contract today is:

- runtime services are not only manual UI-managed resources
- they can also be run-managed resources, with leases bound to heartbeat runs

This is a major architectural truth and should be made explicit.

### 7.7 Run finalization

At terminal states the system currently handles:

- run status finalization
- wakeup status finalization
- retry-once logic for some failures
- issue execution lock release
- deferred wake promotion
- QA settlement for QA agents
- runtime service lease release
- orphan run reaping

This is powerful, but it is also the most overloaded phase in the entire runtime.

## 8. State machines

The runtime needs explicit state machines per object.

### 8.1 Wakeup request state machine

Current practical states:

- `queued`
- `coalesced`
- `deferred_issue_execution`
- `skipped`
- `failed`
- `cancelled`

Meaning:

- this state machine answers "what happened to the request to run?"

### 8.2 Heartbeat run state machine

Current practical states:

- `queued`
- `running`
- `succeeded`
- `failed`
- `timed_out`
- `cancelled`

Meaning:

- this state machine answers "what happened to this execution attempt?"

Critical rule:

Run success must continue to mean technical execution success, not business approval success.

### 8.3 Issue lifecycle state machine

Current lifecycle statuses:

- `backlog`
- `todo`
- `in_progress`
- `in_review`
- `done`
- `blocked`
- `cancelled`

Problem:

This lifecycle is trying to encode at least four different dimensions:

- planning state
- execution state
- review state
- closure state

That is why drift keeps appearing.

Recommended meaning:

- `status` should remain a human-facing work lifecycle
- execution eligibility should be derived from explicit gate objects and execution lock state
- review gating should not rely on status alone

### 8.4 Work-plan gate state machine

Formal record:

- `approvals` row of type `work_plan`

Mirrors:

- `issues.planProposedAt`
- `issues.planApprovedAt`

Recommended states:

- `not_required`
- `missing`
- `pending`
- `approved`
- `rejected_or_cleared`

This should be computed from approval truth plus mirrored timestamps, not inferred indirectly from `issue.status`.

Proposal-cycle rule:

- every proposal cycle begins at the proposal edge, not the approval edge
- the proposal edge is complete only when the system has atomically established:
  - the authoritative live `work_plan` approval row
  - the issue-to-approval link for that live approval
  - `planProposedAt`
  - `planApprovedAt = null`
  - any required execution freeze fields such as `checkoutRunId` / `executionRunId` release for review hold

### 8.5 Execution workspace state machine

Current practical states include:

- `active`
- `idle`
- `in_review`
- `archived`
- `cleanup_failed`

Meaning:

- this state machine should answer whether the workspace is open, reusable, under review hold, or pending cleanup

### 8.6 Runtime service state machine

Current practical states:

- `starting`
- `running`
- `stopped`
- `failed`

Meaning:

- this state machine should answer service health and ownership, independent of issue lifecycle wording

## 9. Current implementation mismatches

These are the main mismatches that explain recent failures.

### 9.1 Plan proposal and plan approval were split across incompatible contracts

Historical failure shape:

- `POST /issues/:id/propose-plan` writes `planProposedAt` but explicitly does not mutate lifecycle status
- `POST /issues/:id/approve-plan` requires `issue.status === "in_review"`
- writable issue statuses exposed through shared validators do not include `in_review`
- approval inbox resolution can still approve the plan and sync `planApprovedAt`

Meaning:

- the official issue route is deadlock-prone
- the approval inbox route is a partial escape hatch
- the system has two approval truths that do not fully agree

This is a control-plane design bug, not just a route bug.

Current branch status:

- `POST /issues/:id/propose-plan` now delegates the proposal edge to `issueService.proposePlan(...)`
- `POST /issues/:id/approve-plan` and `POST /issues/:id/reject-plan` now delegate settlement to `issueService.approvePlan(...)` / `issueService.rejectPlan(...)`
- approval inbox resolution now delegates linked-issue mirror settlement to `approvalService.approveWithLinkedIssueSync(...)` / `approvalService.rejectWithLinkedIssueSync(...)`
- issue route and approval route no longer maintain separate ad hoc `planApprovedAt` synchronization logic

What still remains:

- more read-model assembly should move out of routes over time
- `in_review` lifecycle semantics are still an open product/runtime decision, even though plan approval no longer depends on that status check

### 9.2 Documentation and implementation disagree about runtime service ownership

Existing guide says:

- runtime services are manual UI-controlled
- heartbeat does not auto-start them

Current implementation does:

- `heartbeat` calls `ensureRuntimeServicesForRun`
- run-scoped leases are created
- services may be stopped on run release or idle timeout
- workspace-ready comments are emitted from heartbeat

Meaning:

- operators and developers are reasoning from outdated docs
- the real system is more automated than the guide says

### 9.3 Issue object is carrying both source-of-truth fields and summary fields without a strict separation

The `Issue` type currently mixes:

- lifecycle status
- execution lock ownership
- approval mirror fields
- workspace linkage
- runtime summary
- QA summary
- unblock summary

This is survivable only if authoritative vs derived fields are explicit and enforced. Right now they are not explicit enough.

### 9.4 Heartbeat service has become a god service

`heartbeatService` is now responsible for:

- enqueue policy
- queue selection
- run claiming
- execution
- retry policy
- workspace realization
- runtime service orchestration
- session management
- orphan recovery
- writeback integration
- promotion of deferred work

The problem is not just file size. The problem is architectural coupling:

- it is hard to change one subsystem without accidentally changing others
- invariants are harder to reason about
- tests can pass locally while cross-subsystem behavior still drifts

### 9.5 Text/input sanitation is not consistently enforced at system boundaries

`issueService.addComment()` redacts current-user text but does not sanitize control characters such as NUL.

Meaning:

- route-level business logic can still hand invalid bytes to storage
- comment persistence becomes a silent runtime stability dependency

This is a classic control-plane boundary validation miss.

## 10. Proposed target architecture

The new bottom-layer runtime should be refactored conceptually into five subsystems.

### 10.1 Invocation Control Plane

Owns:

- wakeup intake
- coalescing
- budget gating
- issue execution gating
- deferred promotion
- retry scheduling

Authoritative objects:

- `agent_wakeup_requests`
- `heartbeat_runs` for queued/run binding
- issue execution lock fields

Must not own:

- adapter-specific execution
- workspace/service realization details

### 10.2 Execution Plane

Owns:

- run claiming
- adapter invocation
- session continuity
- logs and usage
- technical outcome finalization

Authoritative object:

- `heartbeat_runs`

Must not decide:

- whether business work is approved
- whether an issue is semantically done

### 10.3 Approval Gate Plane

Owns:

- work-plan approval routing
- approval resolution
- syncing approval truth to issue execution gate mirrors
- blocking execution before approval

Authoritative objects:

- `approvals`
- linked issue-approval relation

Mirrors only:

- `issues.planProposedAt`
- `issues.planApprovedAt`

Critical rule:

Approval gate logic must not require a lifecycle status transition that the system itself cannot produce.

### 10.4 Workspace Plane

Owns:

- base workspace selection
- execution workspace realization or reuse
- persistence of execution workspace metadata
- cleanup and archival semantics

Authoritative object:

- `execution_workspaces`

### 10.5 Runtime Service Plane

Owns:

- service identity/reuse
- process launch/adoption
- health/readiness
- leases and idle shutdown
- persistence and startup reconciliation

Authoritative object:

- `workspace_runtime_services`

Critical clarification:

This plane must explicitly support two modes:

1. manual workspace-controlled services
2. run-managed services with leases

The system already supports both. The design must say so.

## 11. Recommended invariants

These invariants should be treated as runtime law.

### 11.1 Issue execution

- At most one active `queued|running` execution owner may exist per issue.
- If `issues.executionRunId` points to a non-active run, the lock must be repaired or cleared.
- A deferred issue wakeup may only be promoted when the current owner releases.

### 11.2 Plan approval

- If an assigned child issue requires plan approval, execution start must be blocked until approval truth is positive.
- Approval truth must be derived from the approval record plus mirrored timestamps, not from status wording.
- Approving a plan after execution has already started must be rejected consistently across all approval paths.

Pending-gate protected surface:

- a pending plan gate blocks more than "start execution"
- while plan approval is pending, agent-authored execution-side writes must be rejected for at least:
  - checkout
  - generic issue field updates that mutate work state
  - child issue creation
  - issue document writes and restores
  - artifact publication
  - work-product create/update/delete
  - attachment upload/delete
- review comments, rejection feedback, and approval-resolution writes remain allowed because they are part of the approval flow rather than execution flow

### 11.3 Runtime workspace

- Every issue-scoped run must have an explicit resolved execution location, even if that location is "shared project workspace".
- If a new execution workspace is created, the issue must link to it durably when policy says the workspace should be reused later.

### 11.4 Runtime services

- Every running service must have an authoritative persisted record.
- Every persisted running service must be reconcilable on boot.
- Service reuse must be identity-based, not just name-based.

### 11.5 Summaries

- `statusTruthSummary`, `runtimeState`, `qaSummary`, and `platformUnblockSummary` are derived views.
- No gate should rely solely on a derived view when the underlying durable objects disagree.

## 12. Recommended write ownership

To stop state drift, write ownership should be explicit.

### 12.1 Only the approval subsystem may decide plan approval

Allowed writes:

- create/update approval row
- create or resubmit the live `work_plan` approval for a proposal cycle
- write `planProposedAt`
- sync `planApprovedAt`
- clear proposal fields on rejection/reset

Not allowed:

- hidden shadow approvals through comments alone

Proposal-path ownership rule:

- the proposal edge is owned by the approval-gate subsystem, not by a generic issue-update path
- that subsystem is responsible for:
  - inserting the proposal comment or durable proposal artifact
  - setting `planProposedAt`
  - clearing `planApprovedAt`
  - creating or resubmitting the single live `work_plan` approval
  - linking the issue to that authoritative approval
  - applying any required execution freeze mutation

Atomicity rule:

- the proposal edge must be treated as one transactional mutation boundary
- if any of the above writes fails, the system must not leave behind a half-proposed state where the issue mirrors, approval row, and approval link disagree
- side-channel notification and wakeup fan-out may happen after commit, but proposal truth establishment itself must be atomic

Concrete implementation status on this branch:

- `issueService.proposePlan(...)` is now the proposal-edge owner and wraps proposal comment persistence, issue mirror writes, live approval create/resubmit, issue-approval linking, and execution-freeze writes in one transaction
- `issueService.approvePlan(...)` / `issueService.rejectPlan(...)` now own issue-route settlement for the linked live approval and issue mirror fields
- `approvalService.approveWithLinkedIssueSync(...)` / `approvalService.rejectWithLinkedIssueSync(...)` now own inbox-route settlement for the approval row plus linked issue mirror sync in one transaction
- route handlers now act mainly as auth/validation boundaries and post-commit orchestration entry points, rather than being the authoritative place that mutates plan truth
- post-commit comment/activity/wakeup fan-out has been separated from the transactional truth writes; this keeps notifications non-authoritative and failure-tolerant

### 12.2 Only the orchestration subsystem may assign issue execution ownership

Allowed writes:

- `executionRunId`
- `executionAgentNameKey`
- `executionLockedAt`

Not allowed:

- ad hoc route handlers guessing execution ownership outside the central orchestration lock

### 12.3 Only the workspace subsystem may persist execution workspace identity

Allowed writes:

- `execution_workspaces`
- issue linkage to current workspace

Not allowed:

- arbitrary route-level mutation of workspace identity without realization/reuse rules

### 12.4 Only the runtime service subsystem may persist service inventory truth

Allowed writes:

- `workspace_runtime_services`

Not allowed:

- UI-only assumptions that a workspace has no runtime because an in-memory registry was lost

## 13. Recovery and repair model

The runtime system must assume local processes, adapters, and external services can disappear.

### 13.1 Run-level recovery

Already partly present:

- orphaned running runs can be reaped
- automatic retry can enqueue one retry
- issue execution lock can be released and deferred work promoted

Needed direction:

- retry policy should become policy-driven rather than hardcoded "retry once"

### 13.2 Service-level recovery

Already partly present:

- service registry records are written
- persisted runtime services can be reconciled on startup
- idle stop and explicit stop are supported

Needed direction:

- document and formalize the two supported ownership modes: manual and run-leased

### 13.3 Control-plane recovery

Needed direction:

- approval route and issue route must converge on the same gate state model
- stale plan state must be diagnosable without requiring manual SQL/debugging

## 14. What should change first

The highest-leverage fixes are not cosmetic renames. They are contract repairs.

### Priority 0

1. Repair work-plan approval state so all routes agree.
2. Decide whether `in_review` remains a lifecycle status or becomes review-summary-only.
3. Make docs reflect the actual runtime-service behavior.
4. Add text/control-character sanitation at comment/document boundaries.

### Priority 1

1. Split `heartbeatService` into orchestration, execution, and finalization modules.
2. Make retry policy declarative.
3. Centralize execution-start eligibility behind one service that considers:
   - lifecycle
   - approval gate
   - execution ownership
   - cancellation/done state

### Priority 2

1. Generalize QA-specific terminal settlement into capability-based acceptance settlement.
2. Move more summary fields to explicit read-model generation instead of ad hoc route assembly.

## 15. Open design decisions

This document intentionally does not hard-freeze the following decisions yet:

### 15.1 What exactly `in_review` should mean

There are two viable directions:

1. Keep `in_review` as a lifecycle status.
2. Remove review semantics from lifecycle status and express review through explicit gate/read-model state.

The document recommends moving away from status-only review semantics, but does not claim that the migration is zero-cost.

### 15.2 Whether issue-level plan mirrors should remain timestamps or become an explicit gate object

Current model uses:

- `planProposedAt`
- `planApprovedAt`

That is good enough for gating, but weak for diagnosis and replay.

An explicit issue gate state row would be cleaner, but it may be unnecessary if approval synchronization becomes strict enough.

### 15.3 How much runtime-service automation should be operator-visible

The code already supports both manual and run-managed services.

Still open:

- whether the UI should expose those as two explicit product modes
- whether run-managed services should be visually separated from long-lived workspace services

### 15.4 How far to split `heartbeatService` in one iteration

The architecture clearly wants separation, but the migration can be staged:

1. extract pure policy modules first
2. extract execution/finalization next
3. only then split route/service integration boundaries

Progress note:

- plan-review route/service boundaries have already started to converge on this branch
- the larger `heartbeatService` split is still pending and should not be conflated with the approval-gate repair

## 16. Architecture judgment

The current system is salvageable.

Why:

- core durable objects are already present
- issue execution locking already exists
- execution workspaces are already first-class
- runtime services already have durable persistence and reuse logic
- approvals already exist as a formal control-plane object

The main failure is not missing primitives. The failure is that the primitives are not yet governed by one shared contract.

That is good news technically:

- this is a system-integration repair problem, not a ground-up rewrite problem

## 17. Self-review

This section is intentionally critical.

### Finding 1: The current architecture is too centralized in one service

Risk:

- `heartbeatService` is a god object for policy, execution, recovery, and side effects.

Why it matters:

- the next regression is likely to come from a valid local change inside heartbeat that violates a distant invariant.

Recommendation:

- split into `invocation-orchestrator`, `run-executor`, `run-finalizer`, and `issue-execution-gate`.

### Finding 2: Approval truth is still modeled twice

Risk:

- approval rows and issue plan timestamps can drift or be repaired by different code paths.

Why it matters:

- operators cannot predict which UI path is authoritative.

Recommendation:

- treat approval as formal truth and issue timestamps as execution-gate mirrors only.

### Finding 3: Lifecycle status is overloaded

Risk:

- `status` is simultaneously being used to express human workflow, execution activity, and approval hold.

Why it matters:

- route and UI behavior will keep conflicting until these concerns are separated.

Recommendation:

- make execution eligibility and review gating explicit computed state, not status-only semantics.

### Finding 4: Documentation drift is itself a runtime risk

Risk:

- operators configure or debug the system based on guides that describe an older contract.

Why it matters:

- runtime incidents will be misdiagnosed as bugs when they are actually undocumented features, or vice versa.

Recommendation:

- publish one canonical runtime architecture doc and make user/operator guides clearly derivative of it.

### Finding 5: Boundary sanitation is under-specified

Risk:

- route-level text can still break storage or downstream processing.

Why it matters:

- control-plane reliability should not depend on every caller remembering to sanitize text.

Recommendation:

- sanitize once at persistence boundaries for comments, documents, and approval payload snippets.

## 18. References

- `server/src/services/heartbeat.ts`
- `server/src/services/workspace-runtime.ts`
- `server/src/services/issue-status-truth.ts`
- `server/src/services/issue-plan-policy.ts`
- `server/src/routes/issues.ts`
- `server/src/routes/approvals.ts`
- `server/src/services/approvals.ts`
- `server/src/services/issues.ts`
- `server/src/services/issue-plan-side-effects.ts`
- `packages/shared/src/types/issue.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/validators/issue.ts`
- `docs/agents-runtime.md`
- `docs/guides/board-operator/execution-workspaces-and-runtime-services.md`
- `doc/plans/2026-02-20-issue-run-orchestration-plan.md`
- `doc/plans/workspace-product-model-and-work-product.md`
- `doc/plans/workspace-technical-implementation.md`
