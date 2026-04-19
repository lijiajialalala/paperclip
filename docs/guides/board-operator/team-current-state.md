---
title: Team Current State
summary: Canonical record of how the current core teams are actually configured and behaving
---

This page is the saved current-state ledger for the live company configuration.

Use it differently from the [team configuration template](./team-configuration-templates):

- the template is the reference model
- this page is the current runtime truth

When agent rosters, heartbeat settings, routines, dispatch rules, or team workflows change, update this page in the same change.

## Source and scope

This page reflects the live runtime state observed on 2026-04-19 from the local Paperclip API for company `25eb9f83-74a2-4e08-98f8-869ddfef7f5d`.

It focuses on the three core execution teams currently active in this company:

- research
- engineering
- platform quality

## Company-wide snapshot

Observed from the live dashboard on 2026-04-19:

- Agent health: `active=5`, `running=1`, `error=11`
- Task health: `open=18`, `inProgress=3`, `blocked=6`, `done=52`
- Pending approvals: `3`

This means the current bottleneck is not only team design. It is also runtime reliability and recovery.

## Research Team

### Current role in the company

The research team is the current owner for deep research and report generation work. Its active visible project is `调研PO岗位`.

### Current owner and workflow

| Field | Current state |
| --- | --- |
| Team owner | `研究负责人` |
| Reports to | `CEO` |
| Workflow pattern | Heavy multi-lane pipeline |
| Current default lanes | `主研究员` + `交叉研究员` + `证据审校员` + `报告架构师` + `研究审查官` |
| Clarification owner | Not formally encoded; in practice the lead is the only sensible owner |
| Entry points | Manual project issues, delegated subtasks |
| Routine usage | None |
| Dispatch mode | Effectively `event_driven` by issue orchestration, not by routine |
| Shared state contract | Not yet formalized as a blackboard contract |

### Current roster

| Agent | Role in practice | Heartbeat |
| --- | --- | --- |
| `研究负责人` | top-level organizer and closer | enabled, `21600s`, wake-on-demand |
| `主研究员` | mainline evidence collection | enabled, `14400s`, wake-on-demand |
| `交叉研究员` | counterevidence and edge cases | enabled, `14400s`, wake-on-demand |
| `证据审校员` | source and evidence audit | enabled, `14400s`, wake-on-demand |
| `报告架构师` | report assembly | enabled, `14400s`, wake-on-demand |
| `研究审查官` | final review | enabled, `14400s`, wake-on-demand |

### Current health

Observed now:

- all 6 research agents are in `error`
- the research workflow is still the older six-lane default, not the reduced `Lead + Challenger + Editor (+ Auditor)` target shape

### Current active work

Current open blockers in `调研PO岗位`:

- `CMPA-155` is `blocked` at the parent issue level and has no `executionRunId`
- `CMPA-156` is `blocked` at the final review lane and has no `executionRunId`

This means the team is currently in a blocked, non-executing state rather than an actively running state.

### Current drift from target

- Too many default lanes are still always-on.
- Clarification is not yet a first-class gate.
- Final review is still modeled as a standing lane instead of a lighter closeout function.
- Shared state is still implicit in project files and issue flow, not yet a formal blackboard.

## Engineering Team

### Current role in the company

The engineering team owns platform fixes, implementation work, smoke tests, and acceptance closeout. It is also the current place where runtime regressions and platform bugfixes are being repaired.

### Current owner and workflow

| Field | Current state |
| --- | --- |
| Team owner | `技术负责人` |
| Reports to | `CEO` |
| Workflow pattern | Lead-led hub-and-spoke with PM, implementation, and acceptance |
| Current default roles | `技术负责人`, `产品经理`, `前端工程师`, `后端工程师`, `验收审查官` |
| Clarification owner | In practice `技术负责人` |
| Entry points | Manual issues, delegated child issues, approval callbacks |
| Routine usage | None |
| Dispatch mode | Effectively `event_driven` |
| Acceptance mode | Separate acceptance reviewer lane still exists as a distinct role |

### Current roster

| Agent | Role in practice | Heartbeat |
| --- | --- | --- |
| `技术负责人` | architecture, breakdown, orchestration | enabled, `21600s`, wake-on-demand |
| `产品经理` | requirement shaping and PRD work | enabled, `21600s`, wake-on-demand |
| `前端工程师` | frontend implementation | enabled, `14400s`, wake-on-demand |
| `后端工程师` | backend implementation | enabled, `14400s`, wake-on-demand |
| `验收审查官` | final acceptance lane | disabled, `14400s`, wake-on-demand only |

### Current health

Observed now:

- `技术负责人`, `产品经理`, `前端工程师`, `后端工程师` are all in `error`
- `验收审查官` is `idle`

### Current active work

Current notable open work:

- `CMPA-175` is `in_progress` under the engineering owner but has no `executionRunId`
- `CMPA-176` is `in_progress` under the backend engineer but has no `executionRunId`
- several older smoke or acceptance issues remain `blocked`

So the engineering team currently has a state/execution mismatch problem: some issues say `in_progress`, but there is no active execution run bound to them.

### Current drift from target

- Acceptance is still carried by a dedicated QA-style role instead of a generalized acceptance gate.
- The team is still single-owner heavy; the technical lead remains the main orchestration bottleneck.
- There is no separate runtime configuration profile for large parallel epics yet.
- Recovery from blocked or stale child issues still depends heavily on the lead.

## Platform Quality Team

### Current role in the company

The platform quality team owns recurring quality audit work under the `平台质量运营` project.

### Current owner and workflow

| Field | Current state |
| --- | --- |
| Team owner | `质量负责人` |
| Reports to | `CEO` |
| Workflow pattern | Routine-driven batch owner with optional specialist lanes |
| Current specialist lanes | `系统验证师`, `根因分析师`, `工程审计师`, `体验审计师` |
| Entry points | Scheduled routines and manual routine runs |
| Routines | daily deep audit batch, weekly quality summary |
| Dispatch mode | both routines currently use `event_driven` |
| Run issue mode | both routines currently use `top_level_run_issue` |
| Concurrency policy | `coalesce_if_active` |

### Current roster

| Agent | Role in practice | Heartbeat |
| --- | --- | --- |
| `质量负责人` | batch owner and summarizer | disabled, `14400s`, wake-on-demand |
| `系统验证师` | system verification lane | disabled, `14400s`, wake-on-demand |
| `根因分析师` | root cause lane | disabled, `14400s`, wake-on-demand |
| `工程审计师` | engineering quality lane | disabled, `14400s`, wake-on-demand |
| `体验审计师` | UX and process lane | disabled, `14400s`, wake-on-demand |

### Current routines

| Routine | Trigger | Dispatch | Run issue mode | Current observation |
| --- | --- | --- | --- | --- |
| `平台质量深度审计批次` | daily 02:00 | `event_driven` | `top_level_run_issue` | latest run created `CMPA-177` |
| `平台质量周报汇总` | weekly Monday 06:00 | `event_driven` | `top_level_run_issue` | active routine, no active issue now |

### Current health

Observed now:

- `质量负责人` is in `error`
- all four specialist lanes are `idle`
- all five quality agents currently have heartbeat execution disabled

### Current active work

The most important current fact is:

- `CMPA-177` (`平台质量深度审计批次`) exists as a top-level run issue
- it is still `todo`
- it has no `executionRunId`

So the quality team already has the correct parent-issue-per-run direction, but the current execution chain is not actually picking the batch up.

### Current drift from target

- The project has routines, but the team is not yet behaving like an actively scheduled quality system.
- Dispatch is still `event_driven`, not `fixed_parallel_lanes`.
- Specialist lanes are present as roles but dormant in runtime terms because heartbeat execution is disabled.
- The team currently depends on manual intervention to turn a created batch issue into real work.

## Current cross-team observations

The three core teams are all already distinct enough to deserve separate current-state tracking:

- research is over-laned and blocked
- engineering is orchestration-heavy and has issue/run truth drift
- platform quality has the right routine direction but weak execution pickup

This is why the template and the current-state ledger must stay separate:

- the template tells us what a coherent team should look like
- the current-state ledger tells us what the live system is actually doing today

## Maintenance rule

Whenever one of these changes, update this page:

- agent added, removed, or repurposed
- heartbeat settings changed
- routine dispatch or run issue mode changed
- clarification authority changed
- acceptance ownership changed
- a team shifts from example pattern to actual production pattern

If this page is stale, operators will start making decisions from memory instead of from the system.
