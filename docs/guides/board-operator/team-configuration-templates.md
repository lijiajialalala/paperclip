---
title: Team Configuration Templates
summary: A repeatable template for defining team topology, dispatch rules, handoffs, and recovery behavior
---

A Paperclip team is not just an org chart. It is a working model for how tasks enter the team, how they move, when they split into lanes, how they recover, and what counts as done.

Use this guide when:

- you are creating a new team
- you are cleaning up an existing team that has drifted into ad hoc behavior
- you want one page that explains how a team works without reading every agent config
- you want reusable examples that can later become importable team packages

## Why this template exists

Without a standard team sheet, most teams drift into the same failure modes:

- too many agents with no clear workflow
- work split into parallel lanes before the upstream brief is stable
- no explicit owner for user clarification or final sign-off
- recovery paths that depend on a human remembering who to wake up
- runtime settings copied from another team even when the work pattern is different

This template gives every team one visible contract.

## What every team should define

| Field | What to decide | Typical values | Maps to |
| --- | --- | --- | --- |
| Team purpose | What the team is responsible for end to end | research, engineering, quality, growth | team docs, agent instructions |
| Workflow pattern | How work usually moves | pipeline, hub-and-spoke, collaborative, on-demand | org design, delegation rules |
| Team owner | Who owns end-to-end outcomes | lead, manager, director, chief role | `reportsTo`, delegation, final sign-off |
| Default roles | Which roles are normally on | lead, challenger, editor, engineer, reviewer | agent roster |
| Optional roles | Which roles are only enabled for certain work | auditor, security reviewer, specialist lane | conditional agents or optional subtasks |
| Entry points | How work enters the team | manual issue, routine, approval callback, comment wake, webhook | issues, routines, wakeups |
| Dispatch mode | How the team resumes and fans out work | `event_driven`, `fixed_parallel_lanes` | routines, `/issues/:id/resume-chain` |
| Run issue mode | Where each recurring run lives | `top_level_run_issue`, `child_of_fixed_parent` | routines |
| Clarification policy | Who may ask the board or user for missing facts or decisions | owner only, manager only, nobody by default | issue comments, blocked flow |
| Blackboard and artifacts | Where shared state lives | issue documents, work products, comments | issue docs, work products, handoffs |
| Review or challenge policy | How counterarguments and review are handled | one-round challenge, targeted review, no default challenger | subtasks, approvals, comments |
| Acceptance gate | Who decides pass or fail and what object is being gated | QA, acceptance lead, source issue differs from target issue | approvals, acceptance writeback |
| Recovery policy | What happens when work stalls, blocks, or a run is skipped | resume owner, lane wake, defer, fallback | wakeups, `resume-chain`, blocked state |
| Concurrency and cadence | How often the team wakes and whether overlaps are allowed | `coalesce_if_active`, `always_enqueue`, scheduled, on-demand | routines, heartbeat settings |
| Cost profile | Where to spend strong models and where to stay lean | strong lead, cheap editor, on-demand reviewer | agent adapter config, budgets |
| Success signals | What counts as done for this team | signed report, accepted feature, closed audit batch | issue status, acceptance verdict |

## Team Sheet Template

Use this as the minimum fill-in template for any new team.

```yaml
name:
purpose:
workflowPattern:
teamOwner:

defaultRoles:
  - name:
    responsibility:
    alwaysOn: true

optionalRoles:
  - name:
    enableWhen:
    responsibility:

entryPoints:
  - manual_issue
  - routine
  - comment_wake
  - approval_callback

dispatchMode:
runIssueMode:
concurrencyPolicy:
catchUpPolicy:

clarificationPolicy:
  ownerMayAskUser:
  childRolesMayAskUserDirectly:
  timeoutFallback:

blackboard:
  parentIssueDocuments:
    - brief
    - notes
  workProducts:
    - type:
      when:
  commentPolicy:

reviewPolicy:
  style:
  maxRounds:
  resolutionOwner:

acceptanceGate:
  required:
  gateOwner:
  sourceIssueId:
  targetIssueId:
  verdicts:
    - pass
    - fail
    - inconclusive

recoveryPolicy:
  onBlocked:
  onSkippedWake:
  resumeChainOwner:
  laneRecoveryMode:

costProfile:
  strongModelRoles:
    - name:
      reason:
  leanRoles:
    - name:
      reason:

successSignals:
  runLevel:
    - ""
  teamLevel:
    - ""
```

## How to use the template

Fill the sheet in this order:

1. Define the team purpose and workflow pattern.
2. Name the single end-to-end owner.
3. Decide which roles are default and which are conditional.
4. Lock the entry points, dispatch mode, and run issue mode.
5. Decide who may ask for clarification and how long the team waits before falling back.
6. Decide the shared blackboard shape before adding more agents.
7. Decide how review, challenge, and acceptance close the loop.
8. Decide how the team recovers when runs stall, skip, or block.
9. Only then tune cadence, concurrency, and model cost.

If a field is still vague, the team is probably not ready to run at scale.

## Example: Research Team

| Field | Recommended value |
| --- | --- |
| Team purpose | Produce decision-quality research and user-facing reports |
| Workflow pattern | Pipeline with a strong editorial owner |
| Team owner | Research Lead |
| Default roles | Research Lead, Challenger, Editor |
| Optional roles | Evidence Auditor for high-risk or external-facing work |
| Entry points | Manual issue, manager delegation |
| Dispatch mode | `event_driven` by default |
| Run issue mode | Usually issue-driven, not routine-driven |
| Clarification policy | Only the Research Lead may ask the user; child lanes must escalate |
| Blackboard and artifacts | Parent issue documents such as `brief`, `source-matrix`, `skeleton`, `challenge-log`, `final-report` |
| Review or challenge policy | One challenge round by default, two at most for high-risk work |
| Acceptance gate | Lead signs off by default; Auditor may down-rank evidence but should not own the conclusion |
| Recovery policy | If blocked on user-only information, mark blocked once, ask once, then resume on reply |
| Concurrency and cadence | Do not fan out before the brief and source matrix are stable |
| Cost profile | Spend stronger reasoning on Lead and Challenger; keep Editor leaner |
| Success signals | Final report, action memo, and evidence trace agree |

### Research-specific notes

- Do not default to six parallel roles.
- The blackboard matters more than raw search transcript sharing.
- Forum, community, and browser-ground-truth work should be explicit source classes, not accidental side quests.

## Example: Engineering Team

| Field | Recommended value |
| --- | --- |
| Team purpose | Turn approved product or platform work into accepted changes safely |
| Workflow pattern | Hub-and-spoke from a technical owner, with optional lane fan-out for well-shaped epics |
| Team owner | Technical Lead or Engineering Manager |
| Default roles | Product or Technical Lead, implementation engineers, acceptance reviewer |
| Optional roles | Security reviewer, migration specialist, release owner |
| Entry points | Manual issue, delegated feature parent, approval callback |
| Dispatch mode | `event_driven` for most work; `fixed_parallel_lanes` only for pre-shaped epics |
| Run issue mode | Feature parent with explicit child issues for implementation lanes |
| Clarification policy | Only the lead may escalate decision gaps to the board; engineers escalate upward |
| Blackboard and artifacts | Parent issue documents such as `plan`, `design`, `test-plan`, `release-notes`; work products for previews or build outputs |
| Review or challenge policy | Targeted architecture, code, or security review; no open-ended multi-agent debate |
| Acceptance gate | Use a general acceptance gate, not a QA-only writeback chain; source and target issue must be explicit |
| Recovery policy | Parent owner is responsible for reconciling child completion, blockage, and wake order |
| Concurrency and cadence | Keep lead cadence slower, ICs more on-demand, reviewer lanes mostly wake-on-demand |
| Cost profile | Stronger models for planning and risky review, cheaper models for bounded implementation or formatting work |
| Success signals | Code lands, tests pass, acceptance verdict is explicit, and upstream issue closes for the right reason |

### Engineering-specific notes

- A large feature should not become parallel implementation lanes until plan and interfaces are stable.
- Acceptance truth must be separate from raw run success.
- Child completion should wake the correct owner instead of relying on manual babysitting.

## Example: Platform Quality Team

| Field | Recommended value |
| --- | --- |
| Team purpose | Run recurring platform health audits and produce auditable findings batches |
| Workflow pattern | Routine-created parent batch with optional fixed lanes |
| Team owner | Quality Lead |
| Default roles | Quality Lead plus the minimum lanes required for the audit type |
| Optional roles | Security lane, UX lane, release lane, infra lane |
| Entry points | Scheduled routine and manual routine run |
| Dispatch mode | `fixed_parallel_lanes` for stable daily or weekly audit batches; `event_driven` for one-off special investigations |
| Run issue mode | `top_level_run_issue` so each batch has its own auditable parent issue |
| Clarification policy | Routine batches should not require fresh operator approval; escalate only when scope or severity crosses a threshold |
| Blackboard and artifacts | Parent issue documents such as `audit-brief`, `findings-ledger`, `daily-summary`; work products for screenshots, logs, or repro evidence |
| Review or challenge policy | No formal challenger by default; the lead consolidates and de-duplicates findings |
| Acceptance gate | Batch verdict closes the run; follow-up defects become separate issues instead of hiding in comments |
| Recovery policy | `resume-chain` should wake lane owners for fixed-lane batches and the lead for ambiguous batches |
| Concurrency and cadence | Prefer `coalesce_if_active` for recurring runs; avoid stacking stale audit batches |
| Cost profile | Keep routine lanes lean and reserve stronger reasoning for the lead on synthesis or dispute resolution |
| Success signals | One parent batch issue, explicit verdict, linked follow-up issues, and no silent drift into `done` |

### Quality-specific notes

- Daily or weekly quality work should create a fresh parent issue per run.
- Routine scope should be pre-declared, not reopened through generic intake every time.
- Quality teams need strong recovery controls because recurring systems amplify drift quickly.

## Converting a team sheet into runtime configuration

Once a team sheet is stable, convert it into runtime changes in this order:

1. Org tree: create or update the agents and reporting lines.
2. Instructions: align each agent's instructions with the team owner, handoff, and done rules.
3. Routines: add scheduled or manual routines only after dispatch mode and run issue mode are decided.
4. Blackboard: standardize the issue document keys and work product types the team will use.
5. Recovery: define when to use blocked, when to use `resume-chain`, and who owns restarts.
6. Cost: tune models, intervals, and budgets after the workflow is already coherent.

Do not start with cadence and model knobs. Those are last-mile settings, not team design.

## When to create a new template

Create a new team sheet when:

- a team has a different end-to-end owner
- the workflow pattern changes
- the dispatch or run issue model changes
- the clarification policy changes
- the acceptance gate changes

Do not create a new template just because one agent uses a different model or skill.

## What good looks like

A good team template lets an operator answer these questions in under a minute:

- How does work enter this team?
- Who owns the outcome?
- When does the team split into lanes?
- Who is allowed to ask the user for clarification?
- Where does shared state live?
- How does the team recover when something stalls?
- What exactly counts as done?

If the sheet cannot answer those quickly, the team is still underspecified.
