# Merge Gate Checklist

Use this checklist when a branch needs a full merge gate, not a quick skim.

## 1. Intent

- What problem is the branch solving?
- Is the problem real, current, and worth the added code?
- What contract or invariant is being introduced or changed?
- Does the implementation actually solve that contract, or only a nearby symptom?

## 2. Correctness

- Does the main path work?
- Does the real production path work, not only the happy-path fixture?
- Are there legacy or compatibility paths that still need to work?
- Are entrypoints for the same operation still behaviorally consistent?
- Does the branch accidentally collapse two distinct concepts into one state field or lock?

## 3. Complexity

- Did the branch add new state or new modes? If yes, is each one necessary?
- Is there duplicated authoritative truth?
- Is selection based on list order, implicit fallback, or other ad hoc behavior?
- Would a later refactor be likely to reintroduce the same bug because the contract is still underspecified?

## 4. Safety

- Does the branch fail closed where ambiguity would be dangerous?
- Are repair or recovery paths still safe?
- Could stale or partial state make the system lie about ownership, approval, or execution?
- Are there silent defaults that override explicit operator intent?

## 5. Tests

- Do tests cover the exact path that motivated the change?
- Are tests modeling the real data shape, or a simplified surrogate?
- Is there at least one regression test for the bug being fixed?
- If the change is about cross-route or cross-object consistency, is there coverage for that interaction?

## 6. Verification

Prefer this order:

1. targeted unit/integration tests for the changed behavior
2. targeted typecheck or build checks if the change crosses API boundaries
3. full suite only when needed for merge confidence or repo policy

## 7. Recommendation

Use one of these outcomes:

- `merge`: no blocking findings remain
- `merge after fixing X`: the branch is directionally right but still has a concrete blocker
- `do not merge`: the branch solves the wrong thing, leaves core ambiguity unresolved, or introduces unjustified complexity
