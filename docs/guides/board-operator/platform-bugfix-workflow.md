---
title: Platform Bugfix Workflow
summary: How to handle control-plane bugs discovered during task execution without fixing them in the wrong workspace
---

This guide defines the operating rule for platform bug fixes discovered while running normal task delivery.

The core idea is simple:

- Detect and diagnose the bug where it appears.
- Do not implement the platform fix in the wrong project workspace.
- Land the fix on the platform mainline first.
- Validate the fix against the original reproducer.
- Only then migrate it into long-lived stable branches such as `R2` or `R3`.

## When This Workflow Applies

Use this workflow when the issue is a Paperclip platform problem rather than a normal product-task implementation.

Typical examples:

- approval routing is wrong
- issue status transitions contradict governance rules
- review or closeout gates are bypassed
- heartbeat, wake, retry, or lock behavior is wrong
- runtime-service orchestration writes back incorrect issue state
- QA or summary writeback closes issues incorrectly

If the current task workspace is a smoke project, feature sandbox, or customer-project checkout, it is almost certainly the wrong carrier for a platform fix.

## The Boundary Between Diagnosis And Repair

The system may do all of the following automatically:

- reproduce the bug
- collect evidence
- explain the likely root cause
- open a platform fix task
- define acceptance criteria

The system should **not** automatically do all of the following unless the execution carrier has been explicitly corrected:

- implement the fix in the current non-platform workspace
- treat a smoke workspace as the platform source repo
- branch directly from a stable branch such as `R2` or `R3`
- merge or backport before mainline validation

This is the key guardrail. Detection is cheap. Repair in the wrong place is expensive.

## Canonical Execution Carrier

For platform bugs, the execution carrier must be the real platform repository.

In practice:

1. Use the Paperclip source repository, not the smoke-test workspace that exposed the bug.
2. Branch from the platform mainline branch. In this repository that means `master` unless the repo later renames it.
3. Create an isolated bugfix branch for the engineer.
4. Push that branch to remote.
5. Stop there until a human switches validation runtime to that branch and confirms the bug is actually fixed.

Do not treat `R2` or `R3` as the starting point for development. They are release carriers, not the first place to invent the fix.

## Standard Workflow

### Step 1. Detect the bug in the original task flow

Keep the original reproducer intact.

- Record the parent issue, child issues, approvals, and observed bad state.
- Capture why the behavior is wrong in contract terms, not just "it looks odd".
- Preserve enough evidence to replay the same scenario later.

### Step 2. Open a platform fix ticket

The fix ticket should say:

- what failed
- why it is a platform bug
- what repo is the real implementation carrier
- what acceptance check must pass before merge

If the current project/workspace is not the platform repo, call that out explicitly.

### Step 3. Stop automatic implementation in the wrong workspace

If an agent proposes to fix the bug inside the smoke project or another non-platform workspace:

- do not approve that implementation plan
- do not let the agent "just patch it here"
- redirect the work to the correct platform repo and branch policy

If the approval is routed to the wrong approver and the board cannot request revision directly, treat the plan as non-canonical and supersede it with a correctly scoped platform task.

### Step 4. Create a mainline bugfix branch

The engineer working the platform bug should:

1. check out the platform repo
2. branch from `master`
3. implement the minimal fix
4. add targeted regression coverage
5. push the branch

That engineer should not directly patch `master`, `R2`, or `R3`.

### Step 5. Validate on the bugfix branch

After the branch exists, a human or explicit validation operator should:

1. switch the runtime service to the new branch workspace
2. replay the original reproducer
3. confirm the incorrect behavior is gone
4. confirm no nearby control-plane contract regressed

Validation should use the same real path that originally exposed the bug.

### Step 6. Merge mainline first

Only after branch validation is clean should the fix be merged into `master`.

This keeps mainline as the source of truth for platform behavior and avoids inventing divergent fixes separately on stable branches.

### Step 7. Promote into stable branches separately

If `R2` or `R3` also need the fix:

1. decide whether the fix is safe for backport
2. port or cherry-pick it into the stable branch deliberately
3. run branch-specific validation there

Stable-branch promotion is a release decision, not part of first implementation.

## Approval Guidance For Board Operators

When you review a plan for a platform bug, ask these questions first:

- Is this bug actually in the platform/control plane?
- Is the proposed workspace the real platform repo?
- Is the branch based on `master` rather than `R2` or `R3`?
- Does the plan stop at "push branch for validation" rather than auto-merge?
- Is there a real reproducer and acceptance check?

If any answer is no, the plan is not ready for approval.

## What Good Looks Like

A correct platform-bug execution chain looks like this:

1. Smoke task discovers a platform defect.
2. System diagnoses and records evidence.
3. Platform fix task is created with the correct repo and mainline-first branch policy.
4. Engineer pushes a bugfix branch.
5. Human switches runtime to that branch and validates the original reproducer.
6. Branch is merged into `master`.
7. Fix is migrated into `R2` or `R3` only if needed.

That sequence keeps discovery fast, repair safe, and release branches stable.
