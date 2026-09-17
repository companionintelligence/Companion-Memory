# Build chain & devex audit — 2026-09-09

An audit of the platform build chain and developer experience: what is weak, broken, fragile,
misleading, missing or slow, and the fix for each.

**Method.** Nine surfaces (CI gating, release/publish, Docker/compose, Python/uv, JS/yarn, native
builds, local devex, database/migrations, test topology) were surveyed independently against this
checkout, with `origin/main` merged in. Every major and critical finding was then handed to a
second agent whose instructions were to *refute* it and, separately, to judge whether the proposed
fix would actually work. **37 findings survived that pass; 4 were refuted and are listed in §5.**
Of the 37, the verifier rejected or materially corrected the originally-proposed fix in 28 cases —
so the fixes recorded here are the corrected ones, and several say plainly "the obvious fix makes
this worse."

**Confidence and staleness.** Every claim below was checked against this tree or against real
workflow-run logs on the date in the heading, not from memory. Where a number is quoted, the
command that produced it is quoted with it. This document will go stale; §6 says how to re-derive
it. It deliberately does **not** restate the CI trigger table — `docs/CI.md` owns that and carries
the `grep` commands that regenerate it — nor the required-context list, which is read from the API.

---

## 0. Status

| | |
| --- | --- |
| Confirmed findings | 37 (7 major, 30 minor after verification downgrades) |
| Refuted during verification | 4 (§5) |
| Minor/cosmetic, unverified | 32, summarised in §3.8 |
| Already fixed on this branch | 2 — see below |
| Already documented by the repo, still open | 9 |

Four findings were fixed while auditing, all in PR #2641:

- **F4 — `make reset` deleting other worktrees' data.** Now filters on the compose label instead of
  an unanchored name match. Confirmed live before fixing: on one developer machine the old filter
  selected 12 volumes across 3 compose projects where only 4 belonged to the checkout running it.
  The highest-severity finding in this audit, and the only one that destroys data.
- **F23 — `make health`'s hooks repair silently no-opping.** Now enables
  `extensions.worktreeConfig` before the `--worktree` write, and no longer hides the error.
- **F2 — `import/order` violations on `main`** — three files in the maintenance domain,
  byte-identical to `origin/main`. Fixed in `7d4400f15`; the audit found it independently and its
  analysis identified the cause. The structural hole (nothing lints `main`) is still open.
- **Half of F14** — the root `package.json` now declares `test` and `typecheck`, so `make test` and
  pr-gate's existing typecheck lane reach the xtask suite. The dedicated CI lane is still open.

---

## 1. Themes

Six causes explain most of the 37. Fixing a theme retires more than fixing its symptoms.

### T1 — Gates check for *presence*, not *evidence*, and every ambiguity resolves open

Each gate asks a proxy question and accepts a proxy answer. `publish.yml` asks "does a green *run*
of `ci.yml` exist at this SHA" — not "did the backend suite execute". Branch protection asks "is
the context successful, skipped, or neutral", and a failed `install` turns all six required
contexts `skipped`, which **satisfies** them. `desktop-release.yml` asks "did a workflow with this
name pass at this SHA" — a name, not this tree's tests. `mobile-release.yml` asks nothing.

The machinery is sound (§4); the *predicates* are weak. Fixing this is mostly changing what each
gate reads, not rewriting gates.

### T2 — Cost-driven dispatch-only CI removed the ambient signal, and nothing replaced it

Ten of fourteen workflows are dispatch-only for a real, documented reason ($563/month,
`ci-gate-proposal.md` §1). The consequence: **no lane runs on `main` at all.** That single fact
explains a cluster — `ci.yml` red since 2026-08-19 with nobody blocked; ruff violations
accumulating unnoticed in `scripts/benchmark/`; both E2E suites red with no owner; a PR merged with
`Lint backend` red, leaving `main` broken and every subsequent PR inheriting it. Verification is
episodic and human-triggered, so an absent check means nothing and redness has no expiry.

### T3 — Prose is the control plane, and it decays faster than it is re-read — sometimes *causing* the defect

This repo documents itself unusually well, then acts on the documentation rather than the tree.
The clearest case: `ci.yml`'s comment prices the backend suite at "~400 files in about 2.5 minutes"
and calls a 20-minute ceiling generous. Measured: 455 files, timed out at 20:00, ~51% done. **The
stale comment is why the ceiling looks adequate** — a documentation bug that produced the repo's
most serious gating defect.

The repo has already invented the correct pattern: `docs/CI.md` carries the `grep` commands that
re-derive its table, and `ci-gate-proposal.md` explicitly refuses to keep a second copy. The
failure is inconsistent application, not ignorance.

### T4 — Every local guard is bootstrapped by an install the highest-volume contributor cannot complete

`prepare` is `husky && sh scripts/merge-uv-lock.sh --register`. Husky/lint-staged **and** the
`uv.lock` merge driver therefore exist only after a successful `yarn install` — which needs an
interactive `gh auth refresh` for a GitHub Packages scope that agent worktrees and fresh checkouts
do not have. Pre-commit auto-fix is inert exactly where most commits originate. Three auto-fixable
`import/order` errors reached `main` this way. Prevention has migrated rightward from "free, at
commit time" to "expensive, in CI" to "not at all, on main".

### T5 — Test lanes are hand-enumerated per workspace, so *untested* is the default state of new code

`ci.yml` names workspaces one at a time for good, documented reasons (`foreach --all` would drop
the planning coverage ratchet, duplicate the fe-web suite, and bail at the first failure). The cost
is that nothing is reached unless someone adds a line. `grep -rn "yarn test" .github/workflows/`
returns **only a comment**. `@ci/cli`'s 200 tests ran in no workflow until last week; the root
xtask suite runs in none today.

### T6 — Toolchain pins are per-surface dialects, and the strictest checker is the local one

Node is specified five ways across CI, one job still on Node 20, while `make health` hard-fails on
an exact `.nvmrc` match — CI is *looser* than the machine gating `make dev`. `benchmark-unit.yml`
hand-pins `ruff==0.16.1` with nothing tying it to `uv.lock`. `uv.lock` carries eight minor versions
of inference-runtime skew (onnxruntime 1.20.1 on macOS/arm64 vs onnxruntime-gpu 1.28.0 on
linux-x86_64) — the sidecar developers debug is not the one that ships. Rust, Xcode and CocoaPods
are unpinned; base images inconsistently so.

---

## 2. Priority order

Ordered by (risk × likelihood) / effort, not by severity label.

1. **Add `Install dependencies` to `main`'s required contexts.** One `gh api PATCH`, no file edit.
   Closes the only defect here where the gate does not degrade but *vanishes*. (F3)
2. **Shard `Run backend API tests` 4× and bootstrap pg-boss.** Restores the only required gate that
   runs tests. Real work, but the precedent is in-tree. (F1)
3. **Make husky/lint-staged and the uv.lock merge driver work without a completed `yarn install`.**
   Prevents a whole class at the cheapest point; failure rate is ~100% in agent worktrees. (F4, T4)
4. **Add `push: branches: [main]` to `pr-gate.yml`**, with `if: github.event_name == 'pull_request'`
   guards on `test-frontend` and `build-web` (mandatory, not optional — those are the expensive
   jobs) and an `if: failure()` step that opens/refreshes one "main is red" issue. (F2)
5. **Add one root-workspace test lane** running `yarn test`. Ten minutes; the code under test
   decides which images `publish.yml` builds and tags. (F14)
6. **Gate `mobile-release.yml` per lane** — not a verbatim copy of desktop's whole-run gate, which
   would block an iOS release on an unrelated Android failure. Pair with an actual iOS test. (F5)
7. **Migrate branch protection to the ruleset**, add `required_status_checks` there with
   `bypass_actors`, verify, *then* drop the legacy block. Do **not** simply flip
   `enforce_admins: true` — legacy rules have no bypass concept, so that yields a hard block with a
   dead escape hatch. (F6)
8. **One doc-truth pass**, deriving rather than restating. Cheap, but it only stops the *next*
   T3-caused defect. (§3.7)
9. **Toolchain unification** — one Node source of truth, ruff derived from `uv.lock`, pinned bases,
   a checksum on the `dbmate` download, a decision on the onnxruntime skew. Batch it. (T6)
10. **Local devex** — `enableGlobalCache: true`, a documented disk/time budget for `make dev`'s
    ~9.6 GB Ollama pull, one release command replacing ~10 manual dispatches.

### The single highest-leverage fix

**Add `Install dependencies` to `main`'s required status checks.** One API call, touches no tracked
file, cannot itself regress a lane. Today, if `install` fails for any reason — a registry blip, a
cache miss, an expired packages token, the same interactive-auth surface that already blocks fresh
checkouts — all six required contexts resolve to `skipped`, GitHub counts `skipped` as satisfying a
required check, and the PR is mergeable with six grey checks and **no red anywhere**. Nobody would
see a failure to investigate. That is strictly worse than having no gate, because the gate's
existence is what stops people looking.

It fails closed in all three directions (`failure`, `cancelled`, never-started) and preserves the
dispatched-`ci.yml` escape hatch for free, because `ci.yml` already declares a job of that name — so
nothing needs hand-syncing between two workflows. The structural alternative is to drop
`needs: install` from `lint` and `typecheck` (they already run their own `yarn install --immutable`),
making the six contexts unskippable by construction at the cost of some cache warmth.

---

## 3. Findings

### 3.1 Release gating

**F1 — `ci.yml`, the only required gate that runs tests, cannot pass; the current release shipped
via `skip_test_gate`.** *(major, known since 2026-08-29)*
`publish.yml` requires a green `ci.yml` at the release SHA. `ci.yml`'s backend job dies at a
20-minute step ceiling, ~51% through 455 suite files — `##[error]The action 'Run backend API tests'
has timed out after 20 minutes`, identically in runs 34213665353, 34207120701, 34194276965,
34187459426. Last green: 2026-08-19. Release `v2026.9.8.1` logs
`Release gate BYPASSED … ci.yml backend lane cannot pass in CI`.

*Fix, in this order — the obvious fix alone makes it worse.* Bootstrapping pg-boss first would
*lengthen* the run (six suites currently abort in seconds; bootstrapped they execute ~142
Postgres-backed cases) and still hit the ceiling. Raising only the step timeout pushes past the
job's own `timeout-minutes: 35`, which reports as `cancelled` naming no step — the exact failure
`ci.yml`'s own comment says it restructured to avoid.
(1) Shard `Run backend API tests` 4× (`fail-fast: false`), copying `pr-gate.yml`'s frontend
sharding. Handle the coverage trap: `coverageThreshold` is per-process and scoped to
`./src/domains/planning/`, so a shard holding few planning files fails it — either merge per-shard
`coverage-final.json` and enforce once, or drop `--coverage` from the shards and keep one cheap
unsharded planning-only lane carrying the ratchet.
(2) *Then* bootstrap pg-boss, as a named `db:bootstrap-pgboss` script wired into **both** CI and
the local setup path — every fresh checkout hits the same wall. Do not hand-write the DDL as a
migration; pg-boss owns and versions it.
(3) Only then dispatch and measure. (4) Fix `ci.yml`'s "2.5 minutes" comment — it caused this.

*Correction to the finding's own framing:* releases before 2026-09-07 did not bypass the gate, they
predate it. The accurate risk is "the gate is one day old and its main lane has never passed under
it", which is smaller and far more fixable than "three weeks of bypasses".

**F2 — A PR merged to `main` with the required `Lint backend` red, and no lane on `main` reports
it.** *(major)* Branch protection landed 2026-09-08 with `enforce_admins: false`; within a day an
admin merged past a failing required context. Because `pr-gate.yml` triggers only on
`pull_request`, nothing lints `main` after a merge — the redness reappears on every PR branched
from it. Its first recorded use was for three auto-fixable `import/order` errors.
**Fixed on this branch (`7d4400f15`)**, but the structural hole remains.
*Fix:* `push: branches: [main]` on `pr-gate.yml`, with two caveats the obvious version misses —
(a) the `if: github.event_name == 'pull_request'` guard on `test-frontend` and `build-web` is
**mandatory**, not optional, or every merge costs ~36-52 runner-minutes against the stated cost
rationale; (b) `cancel-in-progress: true` keyed on `refs/heads/main` gives "one verdict per burst",
not per commit — the three merges inside 54 seconds that caused this incident would leave one
verdict. Give the push path its own concurrency group if per-commit attribution matters. Add an
`if: failure()` step opening one tracking issue, or it becomes an eleventh unwatched red lane.

**F3 — A failed `install` turns all six required contexts into `skipped`, which GitHub counts as
satisfying them.** *(major)* See §2. *Fix:* add `Install dependencies` to the required contexts.
The tempting alternative — one aggregate `Required checks` job — is mechanically sound (`always()`,
`join(needs.*.result)` and matrix roll-up all verified correct) but permanently destroys the
dispatched-`ci.yml` escape hatch, since `ci.yml` has no job of that name.

**F6 — Branch protection does not bind the account performing almost every merge.**
`enforce_admins: false`, and 13 of the last 15 merges are by one admin. *Fix:* migrate to the
ruleset (`main-protect`, id 5497148) with a `bypass_actors` entry, verify on a throwaway PR, then
drop the legacy block — in that order.

**F7 — No Python check runs automatically on any PR, and the "expensive half" justification is
measurably wrong.** *(major, known)* Every Python check lives in dispatch-only `ci.yml`;
`benchmark-unit.yml` is path-filtered to `scripts/benchmark/**`. A PR rewriting `backend/apps/hbpe/`,
`backend/apps/summary/`, `pyproject.toml` or `uv.lock` gets zero automatic verification.
*Fix:* copy `ci.yml`'s `python` job into `pr-gate.yml` verbatim, keeping the job name `Check Python`
so a dispatched `ci.yml` still reports the same context. Real cost is restoring the ~1.9 GB uv cache
(torch is 708 MB); the checks themselves are under 30s. Then correct the two documents whose numbers
are the stated reason this had not happened.

**F8 — The migration-immutability gate is vacuous at a release tag and absent on every PR.**
**F13 — No CI lane builds the api, gateway, summary or HBPE images.** Six of eight Dockerfiles are
built only by `publish.yml`, which is dispatch-only and refuses non-tag refs. A Dockerfile change
produces a green PR and is first exercised on a release runner with a 150-minute ceiling.

### 3.2 Release and publish

**F5 — `mobile-release.yml` ships signed TestFlight/Play builds on a tag push with no test gate,
while `desktop-release.yml` requires one.** The mobile lane's only jobs are `version`, `ios`,
`android`; all mobile test evidence lives in dispatch-only `mobile-build.yml`, and its iOS lane runs
no test at all. `dry_run` is forced `false` on a push, so a tag cannot be a rehearsal.
*Fix — not a verbatim copy of desktop's gate.* Desktop has one tag prefix and always builds all
three OSes, so a whole-run gate fits. Mobile has three prefixes and runs one lane or both;
`gh run list --status success` filters on the **run's** conclusion, so a verbatim copy blocks an
`ios-v*` release on an unrelated Android failure — and Android is the lane that runs tests, so it is
the likely failure. Gate per lane (check the matching `mobile-build.yml` run's per-job conclusions),
and add an `xcodebuild test` step, since iOS currently has no test for a gate to certify. Note that
adding `always()` to those `if:` expressions would silently disable the gate; comment it.

**F9 — Portal catalog registration fails open; `publish.yml`'s last job goes green having registered
nothing.** Every Portal phase in `publish.sh` degrades to a warning. That is correct for a local
images-only run, but `merge-and-register` runs the same script with `SKIP_IMAGE_PUSH=true`, where
registration is the *only* thing it does. It also prints "✓ Images … pushed" when nothing was pushed.
*Fix:* gate on an explicit `PORTAL_REQUIRED` in the merge job only — a blanket `fail` at the ingest
step would abort before the image push and break the script's documented contract. Note
`PORTAL_API` is defaulted with `:-` before any emptiness check can fire, so capture the pre-default
value if you want to validate it.

**F10 — A partly-failed manifest merge repoints `:latest` for a subset of images.** `merge-manifests.sh`
writes `:${VERSION}` and `:latest` together per image and `continue`s on failure, checking the tally
only at the end — leaving api at the new release and database at the previous one.
*Fix:* order all `:VERSION` merges and verifications before any `:latest` write. **This narrows the
window; it does not close it** — pass 2 is still N sequential cross-repository tag writes, and no
registry offers an atomic cross-repo swap. Do not merge it believing the release becomes atomic.

**F11 — `publish.sh` skips a missing local image with a warning and exits 0**; the `PUSH_SKIPPED`
counter it prints is never incremented. *Fix:* increment it and fail after the loop — but put the
preflight **inside** the Step 3 `else` branch, because `merge-and-register` re-runs the script with
`SKIP_IMAGE_PUSH=true` on a runner that built nothing, and an unguarded preflight would abort
Portal registration on every release.

**F12 — Published images carry no provenance**: no OCI labels, no SBOM, no signature, no GitHub
Release, no recorded digests. Only summary and hbpe get any label (`ci.source-tree`).
*Fix:* compute the labels in TypeScript — `run()` is `spawnSync` with no shell, so
`--label …=$(git rev-parse HEAD)` would label the image with the literal string. Follow
`sidecarStamp`'s existing pattern in `lib/images.ts`.

**F16 — The generated store bundle has drifted from the live CI-Marketplace bundle in both
directions**, losing four fixes the marketplace copy carries, including a POSIX-permission guard
whose own error text says Postgres will fail to initialise without it. Only one drift item is
recorded in the bundle's "KNOWN REMAINING DRIFT" section.

### 3.3 Docker and compose

**F15 — The shipped store bundle pulls an unpinned `busybox:latest` and runs it as root over the
appliance's database directory**, before Postgres starts. It is the only image in the bundle this
org does not build. More broadly no base image is digest-pinned, and two float on minor tags
(`postgres:16-alpine`, `python:3.11-slim-bookworm`) while a sibling correctly pins
`python:3.11.12-slim-bookworm`.
*Fix:* pin busybox by digest. **Do not** "drop the extra image and chown from setup-database" — that
inverts a dependency (`setup-database` depends on `database: service_healthy`, so the reverse
creates a cycle compose rejects), does not mount the db directory, and its entrypoint never
`exec "$@"` so a `command:` override is ignored.

### 3.4 Python

**F17 — The mypy quarantine wildcards two whole packages, so new hbpe/summary code is born
unchecked — and it has grown, not shrunk.** *(known)* `ignore_errors = true` on `ci.hbpe.*` and
`ci.summary.*` directly contradicts the config's own stated intent ("Strict by default, so new code
is born typed") and its instruction to narrow it, which has never happened. 84 files across two
production sidecars are untyped while `make lint` reports "Success: no issues found in 86 source
files".

**F18 — A JavaScript package added under `backend/packages/` breaks the entire Python toolchain**,
with no guard and an error far from the change. Already fired once (`#2636`); nothing prevents the
next. `uv lock --check` is in both `lint` and `build`, so it also blocks image builds and, through
`ci.yml`, a release.

### 3.5 JavaScript

**F19 — The whole-monorepo install is hostage to one 59 KB private CSS package behind an OAuth flow
that cannot run non-interactively.** *(known)* Exactly one package resolves from GitHub Packages —
`@companionintelligence/tokens` — used for a single `@import` in two files. Yarn fails the whole
resolution on one 401, so that package gates the entire root install: every JS test, every lint and
typecheck lane, the xtask program, and `make build IMAGE=gateway`. It has already cost a full audit
cycle elsewhere in this repo's history.

**F20 — The three native `yarn.lock` files are validated by no automatic check** and sit outside the
root `resolutions` pins; they have already drifted. A security pin added to `resolutions` silently
does not reach either shipped mobile app.

**F21 — `enableGlobalCache: false` without zero-installs duplicates ~1.3 GB of Yarn cache per
worktree — 14.6 GB measured on this machine.** The setting exists to support zero-installs, which
was never enabled, so the repo gets neither benefit.

### 3.6 Local devex, database and testing

**F4 — `make reset` in the main checkout matches and deletes *other worktrees'* data volumes.**
*(major)* The filter is `docker volume ls -q --filter "name=$(PROJECT_NAME)"`, and Docker's `name`
filter is an unanchored substring match. In the main checkout `PROJECT_NAME` is the bare stem
`ci-server`, a prefix of every linked worktree's `ci-server-<worktree>`. `|| true` swallows every
error, so a partial wipe is indistinguishable from a clean one — in a repo whose CLAUDE.md has a
"Multi-agent safety" section, with no confirmation prompt.
*Fix:* filter on the compose label, which is what actually owns the resource:
`--filter "label=com.docker.compose.project=$(PROJECT_NAME)"` for both volumes and networks. Also
correct README's claim that `make stop` preserves containers — it runs `docker compose down`.

**F22 — `make dev` can no longer bootstrap a fresh clone.** README makes it the single entry point
and says step 2 "runs `make init`", but the recipe now starts by invoking a yarn binary that only
exists after the install it is supposed to perform. This is the same lesson CLAUDE.md already
records for `health`. *Fix:* a shell preflight ahead of the delegation, not a `_ensure-install`
prerequisite that would re-run `init` on every invocation.

**F23 — `make health`'s husky-hook repair silently no-ops on a clone's first worktree.**
`git config --worktree` refuses to run unless `extensions.worktreeConfig` is already true, which
health never sets; `2>/dev/null` hides the fatal error and it degrades to the warn-only branch. The
comment above it asserts the opposite. What is lost is the dbmate timestamp-collision guard, the
plist and Capacitor checks, and staged-file lint. *Fix:* set the extension before the write and drop
the `2>/dev/null`. **Fixed on this branch** — see §0.

**F24 — `make test` / `yarn test` writes to whichever stack holds port 5432.** The repo has a
three-part guard chain against reaching a sibling worktree's database; the test path is in none of
it. `test` is absent from the Makefile's `DATABASE_PORT` export list, and the jest config reads
`.env`'s hard-coded 5432, probing only for a listening socket — never for `ci.stack_key`.

**F25 — `make dbdestroy && make migrate`, the recovery the drift guard itself prints, cannot work.**

**F26 — Nothing tests the order an installed appliance applies migrations in**; 81 merges added an
out-of-order migration.

**F14 — The root `yarn test` (the xtask suite covering the release image build chain) runs in no CI
lane.** The same mistake `ci.yml` documents having just fixed for `@ci/cli`, one layer up.
*Fix — the obvious placement is wrong:* adding a step to `pr-gate.yml`'s `typecheck` matrix runs it
in all three legs and makes an xtask failure fail the contexts named `Type check backend` and
`Type check frontend`, two of the six **required** checks — silently widening what they mean.
Scoping to the `packages` leg instead makes it advisory, since that context is deliberately not
required. Add a dedicated lane.

**F27 — The Playwright full-stack E2E suite has never executed in CI** — `e2e.yml` dies at
`yarn install` for want of a GitHub Packages token (the same root cause as F19). It is `advisory` in
`GATED_WORKFLOWS`, one word from meaning something.

**F28 — `migration-integrity-check.yml`, a *required* release gate, installs only because of a warm
actions cache** and carries the same missing-token defect as `e2e.yml`.

**F29 — No coverage measurement runs in any automatic lane**, and `@ci/tool-core`'s declared
coverage floor is evaluated nowhere.

### 3.7 Documentation truth

**F30 — README omits `gh` and the `read:packages` login that `make init`/`make dev` hard-require.**
The requirement is documented ~130 lines below the step that already failed. For a non-interactive
session it is a hard stop, not a delay. **The single largest first-hour blocker.**

**F31 — README's Caddy setup has no working Linux path**: `systemctl enable` never starts anything,
and the next three steps (`brew services start`, the Caddyfile path, `caddy trust`) are macOS-only
with no Linux equivalent given. Both failures land *after* ~10 GB of Ollama pulls and image builds.

Also open: four live documents still say `main` has no required status checks (applied 2026-09-08);
`docs/CI.md`'s generated "Cut a release" block still says `--ref main`, which `publish.yml` refuses;
`ci-gate-proposal.md` still warns the benchmark ruff lane is red (it is green); a Dockerfile comment
and a production source comment each assert the opposite of the tree.

### 3.8 Minor and cosmetic

32 further findings were recorded at minor/cosmetic severity and not put through verification:
docker 7, testing 6, ci-gating 4, docs 3, release 3, local-devex 3, python 2, database 2,
javascript 1, native 1. They are lower-confidence by construction — treat them as leads, not facts.

---

## 4. What is healthy

Recording this deliberately, so the document is not read as "everything is broken."

- **The release gate's machinery is well-built; only its inputs are weak.** `GATED_WORKFLOWS` is
  data, not code, so adding a gate is one line. It **fails closed on a malformed entry** rather than
  guessing — a failure mode most hand-rolled gates get wrong. `skip_test_gate` refuses a blank
  reason and writes actor and reason into the run summary. Promoting `e2e.yml` to required is a
  one-word change.
- **Decisions are recorded with their reasoning, not just their outcome.** `ci.yml` explains why the
  meaningful ceiling is on the *step* and not the job, and why lanes name workspaces individually
  instead of `foreach --all`. Both are correct calls with the argument preserved.
- **The fix for the worst defect is already a proven in-tree pattern** — `pr-gate.yml` sharded the
  frontend suite for precisely the ceiling now killing the backend lane.
- **`desktop-release.yml` is a genuinely good gate and a ready-made template.** Priority #6 is "make
  mobile look like desktop", which is a much easier argument than designing from scratch.
- **Migration hygiene is the strongest link in the chain.** Timestamps are stamped by `migrate:make`;
  `check-migration-versions.js` enforces uniqueness in lint-staged *and* before `yarn migrate`,
  deliberately dependency-free so it runs inside the production image. Its header cites the real
  collision it exists to prevent. `migration-integrity-check.yml` is the one gate actually proving
  something at published commits.
- **The local surface is unusually complete** — 52 documented `make` targets with `make help`, a
  per-worktree dev stack with Caddy routing, GPU auto-detection, and `make health` gating `make dev`
  on toolchain versions before anything expensive starts.
- **The repo audits itself accurately and dates its claims.** `ci-gate-proposal.md` opens with a
  status table "checked against the workflow files in this checkout on 2026-09-07, not from memory",
  including an admission that its own opening line had been false for two days, and refuses to keep
  a second trigger table. **Theme T3 is a failure to apply this repo's own best practice — the
  practice itself is already written down here.**

---

## 5. Refuted during verification

Recorded so they are not re-reported. Each was proposed by a surveying agent and knocked down by an
independent verifier:

1. *"Nothing that blocks a release proves the app runs."* False, and contradicted by evidence inside
   the finding itself — `publish.yml`'s build job does more than claimed.
2. *"`docker-compose.production.yml`'s migrate-database does not wait for setup-database."* The YAML
   observations were correct; the central assertion about there being no wait or retry anywhere in
   the path was not.
3. *"The Android store lane has no targetSdk preflight, so a tag push burns an unrecoverable Play
   version code."* The observable fact is true — nothing mechanically enforces the pin — but the
   consequence chain did not hold up.
4. *"The macOS Apple on-device bridge can ship silently absent."* File observations accurate;
   the mechanism was not.

---

## 6. Re-deriving this

Do not trust the numbers above after they age. To regenerate:

```bash
# Which workflows fire automatically (docs/CI.md owns the full table)
grep -lE '^[[:space:]]+(pull_request|push|schedule):' .github/workflows/*.yml

# What actually gates main
gh api repos/companionintelligence/CI-Server/branches/main/protection

# Whether the required release gate can pass
gh run list --workflow ci.yml --limit 20

# Which suites any workflow actually runs
grep -rn "yarn test\|yarn workspace .* test\|pytest\|node --test" .github/workflows/
```

The audit that produced this document ran nine parallel surveys with adversarial verification of
every major finding and of every proposed fix. The fix text above is the *verified* fix, which in 28
of 37 cases differs from what the surveying agent first proposed — if you are tempted by an obvious
one-line version of any fix here, read the paragraph again; several record specifically why the
obvious version is worse.
