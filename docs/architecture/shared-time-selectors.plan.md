# Shared Time selectors — takeoff plan

> Status: **plan.** Takeoff PR: [#2291](https://github.com/companionintelligence/CI-Server/pull/2291)
> (`feat/plan-overdue-reschedule`). Issue: [#2292](https://github.com/companionintelligence/CI-Server/issues/2292).
> That PR ships a working Plan UI and Plan-shaped iOS types. This document is where the
> shared Time vocabulary starts — not a rewrite of that PR.
>
> Catalog: [selectors.md](../design/selectors.md) · Time mocks in
> [selectors-catalog.html](../design/selectors-catalog.html) (`#time`).
> Planning object model: [planning-roadmap.md](planning-roadmap.md) (M4 is adjacent, not this ticket).

Time in CI is **one decision** — a day, a window, or a cadence — never a spoken clock.
App Intents, the web selector catalog, context prompts, and planning writes must resolve
to the same owner-local `YYYY-MM-DD` (and, when an instant is required, noon local).

## Takeoff (already in the overdue-reschedule PR)

What landed, and what to treat as a **Plan-shaped copy** rather than the shared type:

| Surface | What shipped | Why it is not the shared type |
|---|---|---|
| Plan page | Overdue rows get **Reschedule** → Today / Tomorrow / Next week + a date input (`WhenSelector`) | One-off chips; does not use `preset_scope` / `pick_a_day` |
| Writes | `updateTask({ dueAt })` then `scheduleTask({ date })` | Correct write path — keep this |
| iOS | `PlanTaskEntity`, `PlanWhen` AppEnum, optional `Date` intent | `PlanWhen` is Plan-owned; Siri interpolates it, but nothing else can reuse it |
| Dates | `PlanDate` / `dueAtFromLocalDate` / `addLocalDays` | Right helpers, wrong ownership (Plan / iOS files) |

Do not rip this out on day one. New work **extracts** the Time parameter types and points
Plan + Siri at them.

## What is true in the rest of the tree

- Catalog Time types already exist as `SelectorType`: `day_chips`, `pick_a_day`,
  `preset_scope`, `recurrence`, plus web-only `trip_window` / `activity_scrub` / `deep_work`.
  Frontend: `frontend/apps/web/src/components/selectors/`. Backend mirror:
  `backend/apps/api/src/domains/personalization/contextPrompt.types.ts`.
- Context-prompt generation already names `day_chips` / `recurrence` / `pick_a_day` for
  “when something happens or which day to place a plan”, and forbids pasting a clock time.
- Planning storage already matches the catalog: `scheduledFor` and `deferUntil` are
  owner-local dates; `dueAt` is a `timestamptz` minted from a local day. The DST rule is
  in [planning-roadmap.md](planning-roadmap.md) (`date`/`time` in, `timestamptz` out).
- The intent catalog has **no** `planning` domain and **no** `task` entity
  (`IntentDomainKey`, `CI_ENTITIES`). iOS on-device tools are still Search / Recall /
  Find people / Remember. Android can bind whatever the catalog publishes; iOS App Intents
  cannot until the parameter types exist in Swift.

## Shared types (the actual work)

Parameter types, not Plan actions. The action stays domain-owned
(`planning.rescheduleTask(task, day)`); the `day` argument is shared.

| Catalog selector | Decision | Shared type | Resolves to |
|---|---|---|---|
| Day chips / preset “when” | Today / Tomorrow / Yesterday / Next week | `RelativeDay` (`AppEnum` + web option ids) | one `YYYY-MM-DD` |
| Pick a day | a specific calendar day | `Date` (day, not datetime) | the same `YYYY-MM-DD` |
| Preset scope | 7d / 30d / 1y | `TimeScope` | `{ start, end }` dates |
| Recurrence | Daily / Weekdays / Weekly / … | `Cadence` | catalog ids (`daily`, `weekdays`, …) |

Siri interpolates enums (`Move X to Tomorrow`). The date picker is the catalog’s
“Pick date…” fallback — same as the Plan calendar input.

**Value contract**

```
RelativeDay | Date | TimeScope | Cadence
        │
        ▼
owner-local YYYY-MM-DD   (scheduledFor, deferUntil, source.day, scheduleTask date)
        │
        └── dueAt / other instants = noon local via the existing helper
```

Chip ids must be identical across web options, AppEnum raw values, and any JSON Schema
`enum` on a planning intent: `today`, `tomorrow`, `yesterday`, `nextWeek`.

## Sequenced next steps

1. **Lift the date helpers** out of Plan/iOS into one module (web `taskSections` date
   helpers + iOS `PlanDate`). One function: relative day or `Date` → `YYYY-MM-DD`; one
   function: that day → noon-local ISO. Tests stay with the helpers.
2. **Replace `WhenSelector` / `PlanWhen`** with catalog `PresetScopeSelector` /
   `PickADaySelector` (named chips + pick-a-day) and a Swift `RelativeDay` AppEnum.
   Plan overdue reschedule keeps the same two GraphQL writes. Siri phrases keep
   interpolating the enum.
3. **Point one other caller at `TimeScope`** so the type is not Plan-only. Natural
   first: `memory.recall` already takes optional ISO `startDate`/`endDate` as free
   strings — those should become a scope, not two timestamps.
4. **Stop here unless M4 is in flight.** A `planning` intent domain (`planning.findTasks`,
   `planning.rescheduleTask`, later `planning.createTask`) plus a `task` entity is
   [planning-roadmap.md](planning-roadmap.md) M4. This plan does not start search indexing.
   When M4 does start, the `day` parameter on `planning.rescheduleTask` is `RelativeDay`,
   not a new Plan enum. Android OpenAPI tools pick it up from the catalog; iOS App Intents
   remain a typed bind of the same parameters.

## Non-goals

- Do not App-Intent trip-window sliders or activity-scrub histograms. Those are web
  one-decision UIs, not voice.
- Do not send ISO datetimes through Siri or selector values. That fights
  `PlanningTimeService` and the generate-job rule “never paste a clock time.”
- Do not build native Plan screens. Capacitor still renders `/plan`.
- Do not take `deferTask` / `unscheduleTask` in the same ticket. The overdue path
  already moves `dueAt` + `scheduledFor`.
- Do not expand RRULEs here. Cadence ids are catalog labels; real recurrence is
  planning-roadmap **Later**.

## Acceptance (when this plan is executed)

- [ ] Web Plan overdue reschedule uses catalog Time selectors with the shared chip ids
- [ ] iOS `RelativeDay` (not `PlanWhen`) is the interpolatable when-parameter; `Date`
      remains the pick-a-day fallback
- [ ] One non-Plan caller uses `TimeScope` or `RelativeDay` (recall is the default)
- [ ] No new intent publishes a clock time; every write still goes through local date
      then noon-local instant
