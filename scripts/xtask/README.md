# xtask

The repo's build/dev automation as a real program, run via `tsx` (the `xtask` pattern
from `ratatui`). Three root `Makefile` targets — `build`, `dev` and `test` — are now one-line
delegations to it. Every other target, `make help` included, is untouched shell:
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
```

Or directly, which is how you reach the per-command help:

```bash
yarn tsx scripts/xtask/index.ts --help
yarn tsx scripts/xtask/index.ts build --help
yarn tsx scripts/xtask/index.ts build api --env staging --gpu cuda --dry-run
```

Run from the repo root either way: `process.cwd()` is the root every command resolves
paths against.

## Subcommands

| Command  | Flags | Notes |
| --- | --- | --- |
| `build [image]` | `--env local\|staging\|production` (default `local`), `--gpu cpu\|cuda\|rocm` (default: `scripts/detect-gpu.sh`), `--dry-run` | With no `[image]`, builds the ENV-appropriate set: `setup-database database object-store summary hbpe`, plus `api gateway` when ENV is not `local`, plus `setup-secrets` on `production`. `[image]` builds exactly one of `api, gateway, setup-database, database, object-store, setup-secrets, summary, hbpe`, regardless of ENV. |
| `dev` | `--gpu`, `--rebuild` | Shells out to `make health` and `make init`, checks overmind/caddy/ollama, pulls the two required ollama models, rebuilds when a local image is missing or a sidecar's `ci.source-tree` label no longer matches HEAD, then hands off to `scripts/dev-stack/index.ts up`. |
| `test` | — | `yarn workspaces foreach --all run test`, then `node --test` over `frontend/apps/desktop/scripts/**/*.test.cjs` (excluded from the workspaces, so `foreach` cannot see it), then `uv run pytest`. Reports workspaces that declare no `test` script, which `foreach` skips silently. |

Every subcommand takes `--help`, and unknown values for `--env`, `--gpu` and `[image]`
are rejected with the valid list rather than passed to Docker.

## Layout

```
index.ts              subcommand dispatch, --help, SIGINT/SIGTERM handling
commands/build.ts     computeBuildPlan (no Docker; reads files+git) + the build loop
commands/dev.ts       prerequisite checks, image staleness, dev-stack handoff
commands/test.ts      workspace suites, the desktop node --test pass, pytest, coverage report
lib/exec.ts           run() (inherit stdio, throw on nonzero) / tryRun() (capture, never throw) / which()
lib/gpu.ts            GPU detection, Dockerfile pin parsing, wheel-image tag composition
lib/images.ts         *_REPO names, the TAG-derived extra tag, the ci.source-tree sidecar stamp
lib/uv.ts             the uv pin, from required-version in pyproject.toml
lib/identity.ts       REPO / PROJECT_NAME derivation
```

`run` vs `tryRun` is load-bearing: they mirror a Makefile recipe's two shapes, a bare
`@cmd` line and one ending `2>/dev/null` / `|| true`. Using the wrong one turns a
tolerated failure into a hard abort, or hides a real one.

## Tests

```bash
yarn test                                          # tsx --test "scripts/xtask/**/*.test.ts"
yarn tsx --test scripts/xtask/lib/gpu.test.ts      # one file
```

Node's own test runner, no vitest. The root `package.json` declares `test` and
`typecheck`, so these are also reached by `make test` (via `yarn workspaces foreach`)
and by pr-gate's existing `Type check packages` lane. `build.test.ts` deliberately uses
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
