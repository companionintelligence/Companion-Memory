# CI gate proposal

> **Status, re-verified 2026-09-07: partly applied.** This is still a proposal — the open items below are decisions nobody has taken yet, and §3.4 in particular is a repository-settings change no file in this repo can make. But the opening line of this document used to read *"Nothing here has been applied"*, and that has been false since 2026-09-06. Three of its recommendations shipped, one of them in a form this document did not propose. Read §0 before acting on anything below, or you will redo landed work.
>
> The original measurement — 2026-08-26 against `main` at `15fde65c5` — still stands as the *evidence* for the argument (§2). Nothing in the applied set re-measured it.

## 0. What has shipped, what has not

Checked against the workflow files in this checkout on 2026-09-07, not from memory.

| § | Recommendation | State |
|---|---|---|
| 3.1 | A minimum PR gate | **Applied, in a different shape, and since widened past what this section priced.** Not `pull_request:` on `ci.yml` — a new `pr-gate.yml` carries the cheap lint + typecheck subset this section named as the fallback, plus four jobs the section did not propose: `mobile-guards`, `desktop-guards` (the desktop image-tag resolver's own `node --test` suite), `test-frontend` (the whole frontend vitest suite) and `build-web`. `ci.yml` is untouched and still dispatch-only, so the cost decision stays revertible by deleting one file. **The expensive half is now only partly ungated**: the backend suite and the Python lanes still are, the frontend suite no longer is, and the workflow's own header prices the additions at ~20-30 extra runner-minutes per PR against the ~$563/month this document opens with. That is item 3 of §5, and it is now a decision about *keeping* spend, not only about starting it. |
| 3.2 | Lint `scripts/benchmark/` | **Applied**, and pinned harder than proposed: `ruff==0.16.1` rather than the bare `pip install ruff` written below, so a new ruff release cannot turn a passing PR red on its own. The pin is the version the root `uv.lock` resolves. |
| 3.3 | Fix `e2e.yml`'s services | **Applied for `object-store`; `hbpe-service` deliberately rejected.** See the note in §3.3 — the workflow now carries a specific, sourced argument that the seed does not need the sidecar, which contradicts the 2026-08-26 baseline. That contradiction is unresolved. |
| 3.3 | Dispatch the expensive lanes as a release gate | **Not applied.** Nothing enforces it; it is a procedure in §7 of the QA programme, and only as good as whoever fills that table in. |
| 3.4 | Branch protection | **APPLIED 2026-09-08.** `main` now requires six contexts — `Lint root`, `Lint backend`, `Lint frontend`, `Lint format`, `Type check backend`, `Type check frontend` — with `strict: false` and `enforce_admins: false`. `required_approving_review_count` is still 0; reviews were not part of this recommendation. |
| 3.5 | Mandatory `ci-local` per PR | **Not applied**, and now largely moot for lint/typecheck, which §3.1 covers automatically. |

## 1. What actually runs today

**Do not maintain a trigger table here.** [`docs/CI.md`](../CI.md) carries the hand-maintained one, with a per-workflow note and the two `grep` commands that re-derive it from the `on:` blocks; this document used to keep a second copy and it went stale within two weeks — it claimed twelve workflows and nine dispatch-only, when the tree has held fourteen and ten since `desktop-e2e.yml` and `pr-gate.yml` landed.

The two facts this argument actually rests on, both re-checked 2026-09-07:

- **Most workflows still do not self-trigger.** As of today, four of fourteen do (`pr-gate`, `benchmark-unit`, `mobile-release`, `desktop-release`); the rest are `workflow_dispatch`-only, so an absent check means nobody started it. Re-derive before quoting: `grep -lE '^[[:space:]]+(pull_request|push|schedule):' .github/workflows/*.yml`.
- **`main`'s branch protection carried no `required_status_checks` and `required_approving_review_count: 0`** — so a PR could merge with nothing run and nobody's approval, including one whose `pr-gate.yml` run was red. §3.1 shipping changed what *runs* and changed nothing about what *blocks*; §3.4, applied 2026-09-08, is what closed that gap for the six lint/typecheck contexts. Approvals are still not required.

Why it is like this: GitHub Actions was costing the org roughly **$563/month**, almost all hosted compute for checks that run on hardware the org already owns (`docs/CI.md`). Gating was a reasonable response to a real bill. The problem is not that it was gated — it is what the gating left behind.

## 2. What the current posture actually cost

From [`baseline-2026-08-26.md`](baseline-2026-08-26.md), measured over 220 commits merged in three days with nothing run:

| Defect | Would a PR gate have caught it? |
|---|---|
| 131 Prettier violations | **Yes** — `ci.yml` `lint/format` |
| 50 ESLint errors, all auto-fixable | **Yes** — `ci.yml` `lint/backend` + `lint/frontend` |
| 153 ruff errors + 34 unformatted Python files | **Yes** — `ci.yml` `python` |
| 6 real backend unit failures | **Yes** — `ci.yml` `test` |
| 1 real frontend unit failure (`useAuth` Android) | **Yes** — `ci.yml` `test-frontend` |
| E2E suite structurally unable to run | **Yes** — `e2e.yml` |
| iOS build lane broken two ways | **Yes** — `mobile-build.yml` |
| Desktop bundling a non-existent image tag | Partly — `desktop-build.yml` builds, but nothing asserts the tag is published |

The single sharpest illustration, **as measured on 2026-08-26**: 141 of the 153 ruff errors were in `scripts/benchmark`, the one directory covered by an auto-running workflow, because `benchmark-unit.yml` ran `pytest` and nothing else. An auto-running check that does not check the thing gives exactly the same false comfort as no check at all, at the cost of looking green.

> That specific gap is closed — §3.2 shipped, so the lane now runs ruff. **The 141 has not been re-measured since**, and this document should not be read as claiming it is still 141. `ruff` is not installed in this checkout, so the count could not be refreshed while writing this. To settle it: `cd scripts/benchmark && uvx ruff@0.16.1 check . | tail -1` (pin the same version the workflow does, or the numbers will not compare). Expect the lane to be red until someone runs `ruff check --fix . && ruff format .` there — the workflow's own header says so and deliberately carries no `continue-on-error` to hide it.

## 3. Proposal

### 3.1 Turn on a minimum PR gate

> **Applied 2026-09-06, as the fallback rather than the headline — then widened past it.** What shipped is `.github/workflows/pr-gate.yml`, not a trigger on `ci.yml`: `pull_request` against `main` with no path filter, running the lint + typecheck subset priced below at ~2–3 min, plus a `mobile-guards` job (two dependency-free Node scripts, no install, seconds) that this section never proposed. Its lint/typecheck job **names** deliberately match `ci.yml`'s, so a dispatched `ci.yml` reports the same check contexts and can satisfy the same branch-protection rule rather than sitting beside it as a near-duplicate. The lane list is in [`docs/CI.md`](../CI.md)'s `pr-gate.yml` row and moves — read it there rather than from this paragraph. Two more jobs landed on 2026-09-07: a third typecheck lane covering `frontend/packages/*`, and — the change that matters to this section — **`test-frontend`, which runs the whole frontend vitest suite on every PR, plus `build-web`.** So the "~2–3 min" figure priced below is now only the cost of the lint/typecheck lanes; the workflow's header puts the two additions at ~20-30 runner-minutes more. The paragraph below is kept because the **backend suite and the Python lanes are still not gated** — that part of the recommendation is open, and the costing is what a decision on it needs. The frontend part is no longer a proposal but a bill.

Add `pull_request` to `ci.yml` only. Its four lanes need no Docker, no Postgres, no GPU, no secrets — they are `yarn install` plus CPU:

```yaml
on:
  workflow_dispatch:
  pull_request:
    branches: [main]
```

**Cost.** `ci.yml` runs `install`, `test`, `test-frontend`, `typecheck` (×2), `lint` (×4), `python`. Measured locally on this hardware: typechecks 14s + 13s, backend suite 202s, frontend suite 306s, lints seconds, mypy 96s, pytest 56s. On a hosted `ubuntu-latest` with a warm yarn cache, expect roughly **8–14 minutes of runner time per PR** with the jobs in parallel. Use `consent-path-gate.yml`'s own header comment as the estimating methodology — it prices itself at ~4–7 min/PR by the same reasoning.

If that is more than the org wants to spend, the cheap subset is `lint` + `typecheck` alone (~2–3 min): it would still have caught 3 of the 8 defect classes above, including all 334 lint/format violations.

### 3.2 Fix `benchmark-unit.yml` so it checks what it claims

> **Applied 2026-09-06.** Kept here as the record of what was asked for and how what landed differs.

It already runs on every PR touching `scripts/benchmark/**`. Add the lint it is missing — near-zero marginal cost, since the job is already paid for:

```yaml
      - name: Lint
        run: |
          pip install ruff
          ruff check .
          ruff format --check .
```

Two changes were made to that on the way in, both worth keeping if this is ever copied to another lane:

- **`pip install ruff==0.16.1`, not bare `pip install ruff`.** Unpinned, a new ruff release turns a passing PR red with no change of ours, and this lane would then disagree with `ci.yml`'s `python` lane about what a violation is. `0.16.1` is what the root `uv.lock` resolves; keep the two in step.
- **The step runs *after* `pytest`, not before.** A failing step ends the job, and the pre-existing lint debt in that directory would otherwise swallow the test signal that already worked.

There is no ruff config in `scripts/benchmark/pyproject.toml`, so ruff walks up to the repo-root one — the same rules the sidecars are held to. That is deliberate; do not add a local `[tool.ruff]` section to make the lane green.

### 3.3 Keep the expensive lanes on dispatch, but make them a release gate

`e2e.yml`, `mobile-build.yml`, `desktop-build.yml` and `migration-integrity-check.yml` stay dispatch-only. Instead, make them mandatory before a `v*` tag, recorded in the programme's sign-off table:

> **Addendum, 2026-09-07.** Two of those lanes now carry unit tests as well as builds: `mobile-build.yml` runs the Android JVM suites (100 tests, four modules) after `assembleDebug`, and `desktop-build.yml` runs `cargo test` on each host-native matrix entry (six of those tests are platform-gated — four macOS-only in `local_model/apple_bridge.rs`, two Linux-only in `stack_manager.rs` — so the hosts legitimately report three different totals; current figures and the recount recipe are in [`docs/CI.md`](../CI.md), not here). Both are near-free — the toolchain and cache are already paid for by the build in the same job. This **strengthens** §3.3 rather than changing it: the native suites now exist, so the release-gate dispatch list below is the only thing standing between them and a release, and they remain worth nothing until someone dispatches them. Locally they are `make test-android` and `make test-desktop`.

```bash
gh workflow run ci.yml                       --repo companionintelligence/CI-Server --ref <sha>
gh workflow run e2e.yml                      --repo companionintelligence/CI-Server --ref <sha>
gh workflow run mobile-build.yml             --repo companionintelligence/CI-Server --ref <sha>
gh workflow run desktop-build.yml            --repo companionintelligence/CI-Server --ref <sha>
gh workflow run migration-integrity-check.yml --repo companionintelligence/CI-Server --ref <sha>
gh workflow run desktop-e2e.yml              --repo companionintelligence/CI-Server --ref <sha>
```

`desktop-e2e.yml` was not in this list when the document was written because the workflow did not exist. It belongs here and nowhere else: it drives Playwright against the desktop **appliance** — published images, empty database, no seeded account — which is the deliberate opposite of `e2e.yml` (locally built, migrated, seeded). Neither substitutes for the other, and only `desktop-e2e.yml` exercises the path a first-time user actually takes. It takes a published image tag, so it can only run *after* `publish.yml` — dispatch it against the release tag, not the release candidate. See the `desktop-e2e.yml` row in [`docs/CI.md`](../CI.md).

**`e2e.yml`'s services — applied for `object-store`, deliberately rejected for `hbpe-service`.** As written, this section said the workflow started only `database` and `setup-database` and needed both `object-store` and `hbpe-service`. It now starts `database setup-database object-store`, waits on `http://localhost:9000/minio/health/live` and fails the job loudly if minio never answers — so the half of this that was about the import spec is done.

The `hbpe-service` half was **not** applied, and the workflow now carries a comment saying why: nothing in `tests/e2e/` calls the sidecar, and the seed does not either — `scripts/seed-database/seed-hbpe.ts` writes `hbpe.*` rows over the same TypeORM `DataSource` as every other seeder, and `main.ts` stubs `FileService` out of the seed's module graph. Starting it would mean compiling `backend/apps/hbpe/Dockerfile` (a cmake `llama-cpp-python` build) on the runner for a service no assertion touches.

> **This is an open contradiction, not a settled question.** [`baseline-2026-08-26.md`](baseline-2026-08-26.md) §4 records the *opposite*, from two runs actually performed: without `hbpe-service` the seed exited 1 with `TypeError: fetch failed` from `ensure_bootstrap` and left 0 events; with it up on `:8002`, exit 0 and 254 events. Static inspection agrees with the workflow — there is no `fetch` to `HBPE_HOST` anywhere under `scripts/seed-database/` — but `main.ts` calls `module.init()`, which fires `onApplicationBootstrap` across the admin testing module's graph, and `PythonFunctionCrons` schedules an `ensure_bootstrap` fan-out at boot+30s. Whether that path is reachable inside the seed's module graph is exactly what neither reading settles. Somebody has to run it: bring the stack up without `hbpe-service`, run `yarn workspace @ci/be-api migrate` then `cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts`, and record the exit code and `SELECT count(*) FROM ci.events`. Until then, treat a green `e2e.yml` as evidence only about the specs it ran.

If the sidecar does turn out to be needed, note that `hbpe-service` has no host port in the committed compose files; the seed runs on the host, so it needs `8002:8002` via an override.

### 3.4 Branch protection

**Applied 2026-09-08.** This is the one claim in the document that cannot be checked from the tree, so check it from the API rather than trusting this line:

```bash
gh api repos/companionintelligence/CI-Server/branches/main/protection --jq 'keys'
```

It now returns a `required_status_checks` block carrying the six contexts below. Two deliberate choices in it:

- **`strict: false`** — a PR is not forced to rebase every time an unrelated commit lands on `main`. On a repo merging this often, `strict: true` would mean near-continuous rebasing for no correctness gain, since these six lanes do not depend on the merge base.
- **`enforce_admins: false`** — an admin can still force an emergency fix through. The point of the gate is to stop an accident, not to remove the escape hatch.

Three contexts were deliberately EXCLUDED, and the reasoning matters if anyone widens this later. `Mobile native guards`, `Desktop native guards`, `Build web bundle`, `Type check packages` and `Migration versions` have no `ci.yml` twin, so requiring them would mean only a `pull_request` run could ever satisfy the rule and a dispatched `ci.yml` on a hotfix could not clear it. `Run frontend tests` is sharded here (`(1/4)`..`(4/4)`) and unsharded in `ci.yml`, so the names do not coincide. And `unit`/`regression` from `benchmark-unit.yml` are path-filtered to `scripts/benchmark/**`, so they do not report at all on most PRs — requiring them would block every PR that does not touch that directory.

Repository settings, not a file change — it was applied with:

```jsonc
// PATCH /repos/companionintelligence/CI-Server/branches/main/protection
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "Lint root", "Lint backend", "Lint frontend", "Lint format",
      "Type check backend", "Type check frontend",
      "Run backend tests", "Run frontend tests", "Check Python"
    ]
  },
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "enforce_admins": false,
  "restrictions": null
}
```

Context names must match the rendered job names exactly (`ci.yml` builds several from a matrix `name`), so confirm them against one dispatched run before adding them — a context that never reports blocks every PR forever.

Four things about that list changed when §3.1 shipped, and they are the difference between this working and locking the repo. The rule that decides each one: **a context is safe to require only if BOTH `pr-gate.yml` and a dispatched `ci.yml` can report it** — otherwise a hotfix cleared by a dispatch, or a PR that never had one, can never satisfy it.

- **Six of the nine contexts are now reported automatically** by `pr-gate.yml` on every PR, and a seventh is reported in a shape that does not match. The six lint/typecheck lanes are named to match `ci.yml`'s jobs, so either workflow satisfies the rule. `Run frontend tests` is the exception: `pr-gate.yml` grew it on 2026-09-07 and then **sharded it on 2026-09-08**, after an unsharded run was killed by its own 20-minute step ceiling on a hosted runner, so it now reports four contexts — `Run frontend tests (1/4)`..`(4/4)` — while `ci.yml` still runs the suite unsharded as one `Run frontend tests`. The names no longer coincide, so the two are **not** interchangeable. **Add the six. Adding the sharded four is defensible — they are the more thorough check — but it costs the dispatch escape hatch, and you must add all four or none, since each covers a disjoint quarter of the files.**
- **Only `Run backend tests` and `Check Python` still come solely from a dispatched `ci.yml`.** Requiring them without gating the backend and Python lanes means every PR waits on someone remembering to dispatch. Either gate those two lanes first, or leave them out.
- **`pr-gate.yml` reports four contexts the JSON above predates, and none of them may be added**: `Type check packages` (it has **no `ci.yml` twin**, which is on its own disqualifying under the rule above; it was also red when it landed — three `frontend/packages/*` workspaces failing on `Cannot find module '@/lib/utils'` — but that was fixed the same day and the lane exits 0 as of 2026-09-07, so redness is no longer the reason to leave it out), `Build web bundle`, `Mobile native guards` and `Desktop native guards` (each has no `ci.yml` twin, so requiring it would mean only a `pull_request` run could ever satisfy it). Add any of the four the day `ci.yml` grows the same job, not before.
- **`ci.yml` has grown two jobs this list predates** — `Check backend imports` and `Check GraphQL schema and types` (verified in the file, 2026-09-07). Both are cheap but dispatch-only, so they fall on the same side of the rule as `Run backend tests` and belong in the same decision rather than being forgotten. Re-derive the full set before writing any PATCH, from **both** files, since the safe set is their intersection: `grep -n 'name:' .github/workflows/ci.yml .github/workflows/pr-gate.yml` shows the rendered job names, and matrix lanes render as `<job name> <matrix name>`.

Do **not** add these until a green `pr-gate.yml` run exists on a PR into `main`; and do not add them while the lanes are red (§2), or nothing will merge.

### 3.5 If the gate stays manual, make `ci-local` mandatory

The org already runs checks on owned hardware via the sibling `CI-Local-CICD` clone:

```bash
ci-local run --repo CI-Server
```

`ci-local` is not on `PATH` by default — it is the script at `CI-Local-CICD/ci-local`. If §3.1 is rejected on cost, then the programme should require a `ci-local` run per PR, with the result pasted into the PR, and this document should say so in place of §3.4.

> **Mostly overtaken by events.** §3.1's cheap half shipped, so lint and typecheck no longer depend on anyone remembering this — and as of 2026-09-07 neither does the frontend unit suite, which `pr-gate.yml` now runs. What it would still buy is the **backend and Python** suites, so if this is revived, scope it to those two and not to a full re-run of what `pr-gate.yml` already did.

## 4. Two red checks that are not about your code

Both are pre-existing baselines. Neither should be treated as a signal, and neither should be added to branch protection until fixed:

- **`App | BuildTestFlight`** — leftover Xcode Cloud check, reported from App Store Connect, not GitHub Actions. This repo no longer ships `ci_scripts/ci_post_clone.sh` or `xcode-cloud-manual-only.yml`. TestFlight is `mobile-release.yml` (tag or dispatch). Delete `App | BuildTestFlight` in App Store Connect → Xcode Cloud → Manage Workflows so it stops reporting on PRs. Until that happens a Cloud start may still fire and fail later in the build (no abort script). Do not add it to branch protection.
- **CodeQL** — historically failed every run because SARIF upload is rejected with `Code Security must be enabled for this repository`. It is now dispatch-only, so it no longer reports on PRs. Restore `push`/`pull_request` only after GitHub Code Security is enabled for the repo.

> `docs/architecture/test-strategy.md` and the root `CLAUDE.md` **both said** CodeQL ran on push/PR plus a weekly cron. Both have since been corrected, and `codeql.yml`'s own header now carries the reason inline; re-verified 2026-09-07 that the file is `workflow_dispatch:` only.

## 5. Recommendation

Re-ordered 2026-09-07 to drop what is done. The first two items of the original list — §3.2, and §3.1's `lint` + `typecheck` subset — have shipped; §3.3's `object-store` fix has too.

1. **Clear `scripts/benchmark/`'s lint debt.** §3.2's lane is in place but red by construction, and a check everyone has learned to ignore is worse than no check. `cd scripts/benchmark && ruff check --fix . && ruff format .`, then confirm the lane goes green.
2. **Settle the `hbpe-service` contradiction in §3.3** by running the seed once without the sidecar. It is a single run, and until it happens neither `e2e.yml`'s comment nor the 2026-08-26 baseline can be trusted about what a green E2E covers.
3. **Decide on §3.1's remaining half** — the **backend** and Python unit suites. The frontend suite came off this list on 2026-09-07: `pr-gate.yml` now runs it on every PR, so the open question is the other two, plus whether the ~20-30 runner-minutes/PR the frontend suite and `build-web` already cost are worth keeping. This is the live cost question; the ~8–14 min/PR figure in §3.1 is what it needs.
4. **Then §3.4**, and at first only the **six** contexts `pr-gate.yml` reports under names `ci.yml` also uses (the lint and typecheck lanes). Adding `Run backend tests` or `Check Python` before item 3 lands would block every PR on a manual dispatch; adding `Type check packages`, `Build web bundle`, `Mobile native guards`, `Desktop native guards` or the four sharded `Run frontend tests (n/4)` contexts breaks the dispatch escape hatch. §3.4 has the rule and the reasoning.
5. **Add `desktop-e2e.yml` to the release-gate list in §7 of the QA programme** (§3.3). It is the only lane that exercises a first-run appliance, and nothing currently requires it.
