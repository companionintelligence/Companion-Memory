# xtask

The repo's build/dev automation as a real program, run via `tsx` (the `xtask` pattern
from `ratatui`). Four root `Makefile` targets — `build`, `dev`, `test` and `test-db` — are now
one-line delegations to it. Every other target, `make help` included, is untouched shell:
`format`, `lint` and `reset` are sequences of shell commands with no branching, where
a program would add only indirection, and `health` has to keep working on a checkout
too broken to run this program.

## Why

The `build` target's GPU logic was the reason. Picking the HBPE image's Dockerfile
variant means `sed`-ing four values out of `Dockerfile.cuda` and two out of
`Dockerfile.rocm`, running each through a different string mangle (`$(basename ...)`
to drop torch's patch segment, dots stripped for `cp311`, `;` → `_` for `sm86_89_120`
and `gfx1030_1100`), then composing three GHCR wheel-image tags out of the results —
all in Make's expansion rules, where a typo produces a tag with a hole in it rather
than an error, and where nothing could be tested without running a Docker build.
That logic is now `lib/gpu.ts`, with unit tests over the pure parts and a `--dry-run`
that prints the exact `docker build` command lines without a daemon.

## Running it

Through Make, which is how it is normally invoked:

```bash
make build ENV=local GPU=cuda      # ENV defaults to local; GPU is auto-detected
make build IMAGE=api               # one image instead of the whole set
make build DRY_RUN=1               # print the plan, touch nothing
make dev REBUILD=1
make test
make test-db ARGS='src/domains/import'   # database-backed jest suites, in a throwaway Postgres
```

Or directly, which is how you reach the per-command help:

```bash
yarn tsx scripts/xtask/index.ts --help
yarn tsx scripts/xtask/index.ts build --help
yarn tsx scripts/xtask/index.ts build api --env staging --gpu cuda --dry-run
```

Run from the repo root either way: `process.cwd()` is the root every command resolves
paths against.

`test` and `test-db` have to clean up after Ctrl-C and `kill`, so the Makefile starts them as
`yarn node --import tsx scripts/xtask/index.ts <command>`. Use that form, not `yarn tsx`, when you
call them directly: the tsx CLI wrapper SIGKILLs its child if it does not answer a relayed signal
within about 60 ms, and a command blocked in Docker or jest cannot. (`build` and `dev` still use the
wrapper; neither holds a container.) `make test` stops at the step in flight on an interrupt and
reports the rest as `not run`.

## Subcommands

| Command  | Flags | Notes |
| --- | --- | --- |
| `build [image]` | `--env local\|staging\|production` (default `local`), `--gpu cpu\|cuda\|rocm` (default: `scripts/detect-gpu.sh`), `--dry-run` | With no `[image]`, builds the ENV-appropriate set: `setup-database database object-store summary hbpe`, plus `api gateway` when ENV is not `local`, plus `setup-secrets` on `production`. `[image]` builds exactly one of `api, gateway, setup-database, database, object-store, setup-secrets, summary, hbpe`, regardless of ENV. |
| `dev` | `--gpu`, `--rebuild` | Shells out to `make health` and `make init`, checks overmind/caddy/ollama, pulls the two required ollama models, rebuilds when a local image is missing or a sidecar's `ci.source-tree` label no longer matches HEAD, then hands off to `scripts/dev-stack/index.ts up`. |
| `test` | — | One step per workspace that declares a `test` script (`yarn workspace <name> run test`), then `node --test` over `frontend/apps/desktop/scripts/**/*.test.cjs` (excluded from the workspaces, so no workspace step can see it), `uv run pytest`, and the gateway and setup-secrets `sh` suites. **Every step runs even if an earlier one fails**; a summary table says which did not pass and the exit status is nonzero if any did. Ctrl-C stops the run. Reports workspaces that declare no `test` script. |
| `test-db [jest args]` | `--keep`, `--keep-for <duration>`, `--image <ref>`, `--workers <n>`, `--no-retry`; bare words are jest path patterns, everything after `--` goes to jest verbatim | Starts a throwaway container of the appliance's database image, bootstraps it with `scripts/test-db/bootstrap.sql`, migrates it, runs the `@ci/be-api` jest suite against it with `CI_REQUIRE_DB=1` and every connection variable pointing only there, then judges the run (jest verdict, no unexplained skip per `scripts/test-db/allowed-skips.json`, no crash signature in the database's own log) and removes the container. A test file that fails the parallel run is re-run once, serially: FLAKE if it then passes (a warning), REAL if it fails again (`--no-retry` turns this off). Removed on SIGINT, SIGTERM and SIGHUP too. Every run first removes the stale containers earlier runs left behind, but only a `ci-testdb-*` one carrying the label that is over two hours old, outside its `--keep` window (`--keep` stamps a `ci.test-db.keep-until` label: 24h by default, `--keep-for 12h` sets it and implies `--keep`) and has no client connected (`pg_stat_activity`, counted from inside it); one in use, or one it could not ask, is left alone and named. Docker is the only prerequisite. See `docs/CI.md`. |

Every subcommand takes `--help`, and unknown values for `--env`, `--gpu` and `[image]`
are rejected with the valid list rather than passed to Docker.

## Layout

```
index.ts              subcommand dispatch, --help, SIGINT/SIGTERM/SIGHUP handling
commands/build.ts     computeBuildPlan (no Docker; reads files+git) + the build loop
commands/dev.ts       prerequisite checks, image staleness, dev-stack handoff
commands/test.ts      the step list, runSteps (keep-going) + summary table, coverage report
commands/test-db.ts   throwaway-database lifecycle (withThrowaway), migrate, jest, the judging
lib/exec.ts           run() (inherit stdio, throw on nonzero) / tryRun() (capture, never throw) / which()
lib/gpu.ts            GPU detection, Dockerfile pin parsing, wheel-image tag composition
lib/images.ts         *_REPO names, the TAG-derived extra tag, the ci.source-tree sidecar stamp
lib/uv.ts             the uv pin, from required-version in pyproject.toml
lib/identity.ts       REPO / PROJECT_NAME derivation
lib/testDb.ts         test-db's pure parts: args, image choice, container ownership, the reap plan, the env
lib/docker.ts         the few docker CLI calls test-db makes (exec form, ours-only removal and client probe)
lib/reaper.ts         the stale-container reaper: asks the daemon, applies the plan, says what it left alone and why
lib/backstop.ts       test-db's exit-time backstop (container by id or by name, the run's own temp dir)
lib/flakes.ts         the serial-retry policy: classify FLAKE / REAL / UNRETRIED, merge, exit decision
lib/fakeDocker.ts     a model docker daemon for the unit tests (not imported by any command)
lib/noSkips.ts        judges a jest --json report against scripts/test-db/allowed-skips.json
lib/dbLogSentinel.ts  crash-restart signatures in a Postgres log
```

`scripts/test-db/` holds the data the last three read: `bootstrap.sql` (shared with
`.github/workflows/ci.yml`) and `allowed-skips.json`.

`run` vs `tryRun` is load-bearing: they mirror a Makefile recipe's two shapes, a bare
`@cmd` line and one ending `2>/dev/null` / `|| true`. Using the wrong one turns a
tolerated failure into a hard abort, or hides a real one.

## Tests

```bash
yarn test                                          # tsx --test "scripts/xtask/**/*.test.ts"
yarn tsx --test scripts/xtask/lib/gpu.test.ts      # one file
```

Node's own test runner, no vitest. The root `package.json` declares `test` and
`typecheck`, so `test` is also reached by `make test` (via `yarn workspaces foreach`)
and `typecheck` by `make typecheck` — the same command, run locally; nothing in CI
runs it automatically since `pr-gate.yml`, whose `Type check packages` lane covered
this, was deleted 2026-09-17. `build.test.ts` deliberately uses
*this checkout* as its fixture — it calls `computeBuildPlan` against the real root, so
it fails if someone drops one of the Makefile pins below or renames a Dockerfile.

## What deliberately stayed in the Makefile

- **`health`** — the toolchain diagnostic, and a prerequisite checker must not require
  the prerequisites. A ported version failed with a raw yarn error on a checkout that
  had not run `make install` yet. `xtask dev` shells out to `make health`, as the
  original `$(MAKE) health` line did.
- **`distribute-license` / `clean-license`** — public targets, not private helpers of
  `build`: `.github/workflows/e2e.yml`, `video/stage.sh`, `video/stage.real-corpus.sh`
  and `video/README.md` all invoke `make distribute-license` directly. `xtask build`
  calls back into both rather than reimplementing the copy, so there is one
  implementation. `clean-license` runs from a `finally`, so a failed or Ctrl-C'd build
  no longer leaves `LICENSE.md` copies in the infra directories the way an aborted Make
  recipe did.

## The four Makefile pins read by name

`lib/gpu.ts` does not hold these literals; it reads them out of the Makefile's text:

    FLASH_ATTN_VERSION :=
    LLAMA_CPP_PYTHON_REF :=
    LLAMA_CPP_PYTHON_VERSION :=
    AMDGPU_WHEEL_TARGETS ?=

`backend/apps/hbpe/build-{flash-attn,llama-cpp,llama-cpp-rocm}-wheel.sh` already `sed`
the same four lines out of the same file to publish prebuilt wheels. Those scripts are
outside this port's scope, so the Makefile stays the single source of truth for all
consumers — duplicating the values here would create a copy that drifts on the next
pin bump.

Keep the single-space `NAME := value` formatting exactly as shown — the four lines are
deliberately NOT column-aligned with their neighbours. The wheel scripts match a literal
`NAME := ` (`sed -n 's/^FLASH_ATTN_VERSION := *//p' Makefile`), so aligning them breaks
those scripts; they guard with `:?` and fail loudly, but only at publish time. `readPin`
here matches whitespace loosely so this side survives that edit, and `readPinOrThrow`
refuses an empty result rather than interpolating a hole into an image tag on the path
`make publish` builds every released image from.
