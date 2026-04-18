---
name: merge-gate-review
description: >
  Review a branch or compare range before merge and decide whether it should land.
  Use when the user asks for merge readiness, branch review, pre-merge gatekeeping,
  PR assessment, or a recommendation to merge/block. Focus on what the change is
  trying to do, whether it is necessary, whether it is correct, whether it adds
  avoidable complexity, what regressions or contract drift it introduces, whether
  tests/docs cover the real behavior, and give a clear merge recommendation.
---

# Merge Gate Review

Run a merge gate review, not a style pass. Determine what the branch is trying to change, whether that change is worth landing, whether the implementation is correct, and whether the resulting complexity is justified.

## Workflow

1. Establish the review target.
   Read the branch name, compare range, or exact commits under review.
   Confirm whether the user wants a whole-branch review or a re-review of specific fixes.

2. Reconstruct intent before judging code.
   Read the diff summary and the smallest set of files that explain the new behavior.
   State the branch goal in plain language: what problem it is solving, what new contract it introduces, and what user-visible behavior changes.

3. Judge whether the change is worth landing.
   Check whether the branch removes a real ambiguity, regression, or operational pain point.
   Call out unnecessary surface area, duplicated truth, extra abstractions, or features that do not clearly pay for their complexity.

4. Review for correctness and contract integrity.
   Prefer high-signal findings:
   - incorrect behavior on real paths
   - hidden regressions
   - stale or split sources of truth
   - entrypoint inconsistencies
   - fail-open behavior where fail-closed is required
   - missing ownership or lifecycle invariants
   - tests that only cover a synthetic path while the production path differs
   Use [references/checklist.md](references/checklist.md) when you need the full review rubric.

5. Verify the risky path.
   Run the narrowest commands that prove or disprove the suspected issue first.
   If the branch claims a finding is fixed, re-run the exact targeted tests or checks that cover that fix before changing your recommendation.
   Expand to broader verification only after the critical path looks sound.

6. Produce the decision.
   Give findings first, ordered by severity.
   Then give a short assessment of what the branch is trying to do and whether it succeeds.
   End with a direct recommendation:
   - `merge`
   - `merge after fixing X`
   - `do not merge`

## Review Standard

Prioritize bugs, behavioral regressions, contract mismatches, recovery gaps, and missing tests over style commentary.

Do not block on nits when the implementation is otherwise sound.

Do block when any of these are true:
- the branch solves the wrong problem
- the implementation only works on a synthetic path
- the change increases state ambiguity or duplicates authoritative truth
- two entrypoints for the same operation now disagree
- recovery or repair semantics become less safe
- tests miss the path most likely to fail in production

## Output Contract

When writing the review:

- Put findings first.
- Include file and line references for each finding.
- Keep findings factual and concrete: describe the failing path, not just the code smell.
- If there are no findings, say that explicitly.
- After findings, summarize:
  - what the branch is trying to do
  - whether that is the right change
  - whether the implementation is appropriately simple
  - whether you recommend merge

## Re-Review Rule

If the user says a finding was fixed:

1. Inspect the exact fix commit or updated diff.
2. Check that the fix addresses the production path, not only the test fixture.
3. Re-run the most relevant verification.
4. Update the recommendation only after the evidence changes.

## Scope Control

Keep the review focused on merge risk.

Do not drift into unrelated refactoring ideas unless they explain a concrete merge risk.
Do not require perfection; require that the branch is safe, coherent, and worth landing now.
