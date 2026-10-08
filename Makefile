.DEFAULT_GOAL := help

RED=\033[0;31m
GREEN=\033[0;32m
YELLOW=\033[0;33m
BLUE=\033[0;34m
RESET=\033[0m

# Repo identity stem, anchored to the origin remote's repo name (its dir
# basename is transient/unreliable — "main", a code, etc.), then CWD when there
# is no remote. This is the stable prefix every stack's name shares, across all
# worktrees, and the single source of truth for the volume/stack naming convention.
REPO := $(shell \
	repo=$$(basename -s .git "$$(git remote get-url origin 2>/dev/null)" 2>/dev/null); \
	[ -n "$$repo" ] || repo=$$(basename "$(CURDIR)"); \
	echo "$$repo" | tr '[:upper:]' '[:lower:]')

# Compose project identity = the repo stem, plus a linked worktree's own dir
# basename (git-dir != git-common-dir), so each worktree gets an isolated stack
# that can't collide with another worktree's (e.g. ci-server-feat-a).
PROJECT_NAME := $(shell \
	repo="$(REPO)"; \
	if [ "$$(git rev-parse --git-dir 2>/dev/null)" != "$$(git rev-parse --git-common-dir 2>/dev/null)" ]; then \
		repo="$$repo-$$(basename "$$(git rev-parse --show-toplevel 2>/dev/null)" | tr '[:upper:]' '[:lower:]')"; \
	fi; \
	echo "$$repo")

# Pin Compose's project name to match, so the compose stacks and reset's
# volume/network filters always agree regardless of the checkout directory.
export COMPOSE_PROJECT_NAME := $(PROJECT_NAME)

# Drive Overmind's tmux session name off the same identity, so concurrent
# worktrees get distinct dev sessions instead of colliding on a shared name
# (Overmind otherwise falls back to the working-dir basename) and `reset` can
# target the exact session this checkout started.
export OVERMIND_TMUX_SESSION_NAME := $(PROJECT_NAME)

export API_REPO ?= ci/api
export DATABASE_REPO ?= ci/database
export GATEWAY_REPO ?= ci/gateway
export OBJECT_STORE_REPO ?= ci/object-store
export SETUP_SECRETS_REPO ?= ci/setup-secrets
export SETUP_DATABASE_REPO ?= ci/setup-database
export SUMMARY_REPO ?= ci/summary-service
export HBPE_REPO ?= ci/hbpe-service

# The seed's target user — must match the SEED_USER_ID default in
# backend/apps/api/scripts/seed-database/data/users.ts. Override it to point
# `seed` and `predict` at an existing account instead of John Smith.
SEED_USER_ID ?= b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b
# Exported so `make seed SEED_USER_ID=<uuid>` reaches the node process; a
# variable set on make's command line is not otherwise passed to recipes.
export SEED_USER_ID
JOHN_SMITH_USER_ID := $(SEED_USER_ID)

export TAG ?= $(shell git describe --tags --exact-match 2>/dev/null)

# Subdirectory build contexts that need a copy of LICENSE. Images built
# from the repo root (api, gateway, and the Python services) read LICENSE.md
# directly and are not listed here.
LICENSE_DIRS := \
	infrastructure/database \
	infrastructure/object-store \
	infrastructure/setup-database \
	infrastructure/setup-secrets

# ---------------------------------------------------------------------------
# Native test toolchains (`test-android`, `test-desktop`)
# ---------------------------------------------------------------------------

ANDROID_APP_DIR := frontend/apps/android/android
DESKTOP_TAURI_DIR := frontend/apps/desktop/src-tauri

# Mirrors of what the Gradle build actually declares: `compileSdkVersion` in
# $(ANDROID_APP_DIR)/variables.gradle, and the `jvmTarget`/`JavaVersion` lines in
# each module's build.gradle. They exist only so the precondition messages can
# name the version they want and the sdkmanager line that installs it.
ANDROID_JDK_MAJOR := 21
ANDROID_COMPILE_SDK := 36
ANDROID_BUILD_TOOLS := 36.0.0

# Where the Android SDK is, resolved the way every Android tool resolves it and
# NEVER hard-coded: ANDROID_HOME, then the deprecated-but-still-common
# ANDROID_SDK_ROOT, then the `sdk.dir` Android Studio writes into the project's
# git-ignored local.properties. Empty when the machine has told us nothing —
# which `test-android` reports as an error with the fix in it, rather than
# guessing a path and failing somewhere less obvious.
android_sdk_dir = $(strip $(or $(ANDROID_HOME),$(ANDROID_SDK_ROOT),$(shell sed -n 's/^ *sdk\.dir *= *//p' $(ANDROID_APP_DIR)/local.properties 2>/dev/null | head -n1)))

# System libraries the Tauri crate links on Linux, as pkg-config names (what the
# *-sys build scripts actually query) and as the apt line that installs them —
# the same set desktop-build.yml installs on its ubuntu runner.
DESKTOP_LINUX_PKGCONFIG := glib-2.0 gtk+-3.0 webkit2gtk-4.1 libsoup-3.0
DESKTOP_LINUX_APT_PACKAGES := pkg-config libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

# Helper: emoji $(2) when goal $(1) is the one invoked at top level, else ➤.
# The MAKELEVEL/MAKECMDGOALS guard keeps the icon to the directly-requested
# target, so recursive sub-makes fall back to the plain arrow.
task_icon =$(if $(and $(filter 0,$(MAKELEVEL)),$(filter $(1),$(MAKECMDGOALS))),$(2),➤)

# Detects which environment (local|staging|production) is currently up by
# reading the running compose project's config files from Docker as the source
# of truth.
running_env = $(shell docker compose ls --format json 2>/dev/null \
	| tr ',' '\n' \
	| grep -F "$(CURDIR)/docker-compose." \
	| sed -n 's|.*/docker-compose\.\([a-z]*\)\.yml.*|\1|p' \
	| grep -E '^(local|staging|production)$$' \
	| head -n1)

# Host port the running stack published for Postgres, read straight off this
# project's running `database` container (the source of truth) so DB-touching
# targets reach this worktree's database even on a dynamic (ephemeral) port. We
# query the container by its compose labels rather than `docker compose port`,
# which depends on resolving the compose model (file paths, active profiles) and
# returns nothing for a profile-gated service on some Compose versions.
#
# Empty means no `database` container is running for this project, and there is
# no safe fallback: 5432 belongs to whichever stack happened to claim it, which
# is often another worktree. The primary checkout used to assume 5432 here, and
# that is how seed/migrate/dbclear reached a sibling stack's database and left
# it on a schema no branch describes. No container, no port — the $(error)
# below then names the fix instead.
db_host_port = $(shell \
	docker ps \
		--filter "label=com.docker.compose.project=$(COMPOSE_PROJECT_NAME)" \
		--filter "label=com.docker.compose.service=database" \
		--format '{{.Ports}}' 2>/dev/null \
		| sed -n 's/.*:\([0-9]*\)->5432\/tcp.*/\1/p' | head -n1)

# Point every local-DB target at that port. node-config reads DATABASE_PORT, and
# dotenv won't override an already-set env var, so this wins over .env's 5432.
# Evaluated lazily per target, so non-DB targets never pay the Docker lookup.
seed migrate dbclear dbdestroy dbshell dburl chatreset filereset gentoken signup testuser userpw hub-account-link: export DATABASE_PORT = $(or $(strip $(db_host_port)),$(error No running 'database' container for project '$(COMPOSE_PROJECT_NAME)'. Start its stack first with 'make dev'.))

define switch_env
	@CURRENT="$(running_env)"; \
	if [ -n "$$CURRENT" ] && [ "$$CURRENT" != "$(1)" ]; then \
		printf "➤ $$CURRENT services are running, stopping before starting $(1)...\n\n"; \
		$(MAKE) stop; \
	fi
endef

# Bring up environment $(1) only when it is not already the running one,
# delegating to its target (which switches away from any other env first).
define ensure_env
	@CURRENT="$(running_env)"; \
	if [ "$$CURRENT" = "$(1)" ]; then \
		printf "$(GREEN)✓$(RESET) $(1) services already running\n\n"; \
	else \
		$(MAKE) $(1); \
	fi
endef

# ─────────────────────────────────────────────────────────────────────
# Build configuration (consumed by the `build` target)
#
#   make build ENV=local|staging|production  GPU=cpu|cuda|rocm
#
# ENV selects which images are built (local omits API/gateway/secrets).
# GPU selects the HBPE base image (cpu = the default Dockerfile). Left
# unset, it's auto-detected from this host's GPU hardware (see
# scripts/detect-gpu.sh) — explicitly passing GPU=... on the command line
# or environment always wins and skips detection.
# ─────────────────────────────────────────────────────────────────────
ENV ?= local
GPU ?= $(shell scripts/detect-gpu.sh)
# REBUILD=1 forces `dev`/`local` to rebuild local images; unset reuses them.
REBUILD ?=

# The GPU/wheel-tag build logic that used to live below this point —
# LOCAL_IMAGES, sidecar_stamp, VALID_ENVS/VALID_GPUS, HBPE_DOCKERFILE*,
# UV_VERSION, the derived HBPE_TORCH_*/HBPE_CUDA_*/HBPE_PY_*/HBPE_ROCM_*
# values, the wheel-image tag compositions, and HBPE_GPU_BUILD_ARGS — now
# lives in scripts/xtask/lib/gpu.ts, scripts/xtask/lib/uv.ts and
# scripts/xtask/lib/images.ts, run by the `build`/`dev` targets below. Only
# the 4 raw pins the wheel-publish scripts (build-{flash-attn,llama-cpp,
# llama-cpp-rocm}-wheel.sh) still `sed` out of this file by name stay here.

# The llama-cpp-python pin: a commit on the JamePeng fork, which tracks
# llama.cpp HEAD and can load Qwen3.5 GGUFs (the official PyPI package is
# frozen at llama.cpp Aug 2025 and cannot). All three HBPE images build
# this same commit with hardware-specific CMake flags; the pin lives here
# because the install happens only in Dockerfiles, passed as a build arg.
# Bump deliberately: the fork moves fast and is our inference stack.
#
# Read by name (not just by `build`) by backend/apps/hbpe/build-{llama-cpp,
# llama-cpp-rocm}-wheel.sh, which `sed` it straight out of this file to
# publish a wheel, and by scripts/xtask/lib/gpu.ts the same way. Keep the
# `NAME := value` formatting byte-exact or all three break.
LLAMA_CPP_PYTHON_REF := 81190b03f6d177988112dad5fc919491a77705d1

# The version the fork reports AT that ref, which is not derivable from it —
# it comes from the fork's own metadata and is only known after a build. Its one
# job is to name the published wheel, so BUMP IT WITH THE REF ABOVE: get it from
# the filename build-llama-cpp-wheel.sh exports into dist-llama/. Wrong here and
# the default wheel tag points at nothing, which fails the pull loudly rather
# than installing anything incorrect.
#
# Read by name, same as LLAMA_CPP_PYTHON_REF above and for the same reason —
# by build-{llama-cpp,llama-cpp-rocm}-wheel.sh and scripts/xtask/lib/gpu.ts.
LLAMA_CPP_PYTHON_VERSION := 0.3.46

# GPU/HBPE wheel-tag auto-detection (what used to live here as AMDGPU_TARGETS)
# is now scripts/xtask/lib/gpu.ts's detectAmdgpuArch(), called by `build`/`dev`
# below; still backed by scripts/detect-gpu.sh --amdgpu-arch, unchanged.

# The gfx targets the PUBLISHED ROCm wheel is compiled for, which is a different
# question from AMDGPU_TARGETS above. That one is "what card is in front of me"
# and is right for a source build; this one is "what cards must one artifact
# serve", because a published wheel is built once and pulled by every appliance.
#
# The set is not invented here — it is the same one Dockerfile.rocm's
# PRUNE_GFX_ARCHS step deliberately KEEPS, documented there as gfx1030
# (RX 6800/6900), gfx1100-1103 (RX 7000 and the Phoenix APU), gfx1150/1151
# (Strix APUs) and gfx1200/1201 (RX 9000). A wheel narrower than that would
# leave a card whose rocBLAS kernels this image ships without any ggml kernels,
# which is an incoherent pairing. All nine are supported by the ROCm 7.2
# toolchain (verified with `llc -march=amdgcn -mcpu=help` in the builder image).
#
# The cost is real and worth knowing: HIP emits a code object per target, so
# both the compile and the shipped libggml-hip.so scale with this list. Trim it
# if the fleet is narrower than the prune policy assumes — but trim both.
#
# Read by name, same as the two LLAMA_CPP_PYTHON_* pins above and for the same
# reason — by build-llama-cpp-rocm-wheel.sh and scripts/xtask/lib/gpu.ts.
AMDGPU_WHEEL_TARGETS ?= gfx1030;gfx1100;gfx1101;gfx1102;gfx1103;gfx1150;gfx1151;gfx1200;gfx1201

# The flash-attn pin. Installed outside the lock for the same reason
# llama-cpp-python is — it needs --no-build-isolation plus build-time
# environment variables, neither of which uv can express in a manifest — so it
# needs pinning here or not at all. It was the one unpinned dependency in the
# repo: `uv pip install flash-attn` resolved to whatever was newest that day,
# so two builds of the same commit could produce different images.
#
# CUDA only. flash-attn has no ROCm build, and the CPU image has no use for it.
#
# Read by name, same as the pins above — by build-flash-attn-wheel.sh and
# scripts/xtask/lib/gpu.ts. Keep the `NAME := value` formatting byte-exact.
FLASH_ATTN_VERSION := 2.8.3.post1

# Everything else that used to follow here — FLASH_ATTN_WHEEL, the prebuilt
# wheel-image tag compositions (FLASH_ATTN_WHEEL_IMAGE, LLAMA_CPP_WHEEL_IMAGE,
# LLAMA_CPP_ROCM_WHEEL_IMAGE), the HBPE_TORCH_*/HBPE_CUDA_*/HBPE_PY_*/
# HBPE_ROCM_* values derived from the HBPE Dockerfiles, the two `ifeq`
# Dockerfile-pin guards, and HBPE_GPU_BUILD_ARGS — now lives in
# scripts/xtask/lib/gpu.ts, exercised by `xtask build`'s HBPE step. The 5
# escape hatches documented there (`make build GPU=cuda FLASH_ATTN_WHEEL_IMAGE=`
# and friends, to force a source compile) still work exactly as before: GNU
# Make exports any `VAR=value` given on the command line to the recipe's
# shell even when this Makefile no longer declares that variable.

define BANNER
   ______                                  _
  / ____/___  ____ ___  ____  ____ _____  (_)___  ____
 / /   / __ \/ __ `__ \/ __ \/ __ `/ __ \/ / __ \/ __ \\
/ /___/ /_/ / / / / / / /_/ / /_/ / / / / / /_/ / / / /
\____/\____/_/ /_/ /_/ .___/\__,_/_/ /_/_/\____/_/ /_/
    ____      __    /_/_____
   /  _/___  / /____  / / (_)___ ____  ____  ________
   / // __ \/ __/ _ \/ / / / __ `/ _ \/ __ \/ ___/ _ \\
 _/ // / / / /_/  __/ / / / /_/ /  __/ / / / /__/  __/
/___/_/ /_/\__/\___/_/_/_/\__, /\___/_/ /_/\___/\___/
                         /____/
endef

export BANNER

.PHONY: help
# Sourced from: https://marmelab.com/blog/2016/02/29/auto-documented-makefile.html
help: ## List make commands with their descriptions
	@printf "$$BANNER\n\n"
	@printf "\033[33mCommands:\033[0m\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
	@printf "\n"

# Kept as shell, and kept PUBLIC: these are not private helpers of `build`.
# `.github/workflows/e2e.yml`, `video/stage.sh` and `video/stage.real-corpus.sh`
# all run `make distribute-license` directly before their own `docker build`
# lines, and `video/README.md` documents it as a hand-run step. `xtask build`
# calls back into these two rather than reimplementing the copy, so there is
# exactly one implementation and no yarn/tsx dependency on a `cp` loop.
.PHONY: distribute-license
distribute-license:
	@for dir in $(LICENSE_DIRS); do \
		cp LICENSE.md "$$dir/LICENSE.md"; \
	done

.PHONY: clean-license
clean-license:
	@for dir in $(LICENSE_DIRS); do \
		rm -f "$$dir/LICENSE.md"; \
	done

.PHONY: reset
reset: ## Reset the local development environment
	@printf "$(call task_icon,reset,🧹) Resetting Docker environment INCLUDING ALL DATA...\n\n"

	@$(MAKE) stop

	@if [ -S .overmind.sock ]; then \
		printf "\n➤ Stopping Overmind dev session...\n\n"; \
		overmind quit 2>/dev/null || true; \
	fi

	@# Selected by the COMPOSE LABEL, not by name. Docker's `name` filter is an
	@# unanchored substring match, and in the main checkout PROJECT_NAME is the
	@# bare repo stem (`ci-server`) — a prefix of every linked worktree's
	@# `ci-server-<worktree>`. So the name form selected every OTHER worktree's
	@# volumes too and fed them all to `rm -f`, with `|| true` hiding the result.
	@# Measured on one developer box: 12 volumes across 3 compose projects, where
	@# only 4 belonged to the checkout running the command. The label is exact
	@# rather than name-shaped, and it is what actually owns the resource.
	@VOLS=$$(docker volume ls -q --filter "label=com.docker.compose.project=$(PROJECT_NAME)"); \
	if [ -n "$$VOLS" ]; then \
		printf "\n➤ Removing project volumes...\n"; \
		printf "$$VOLS\n"; \
		echo "$$VOLS" | xargs docker volume rm -f >/dev/null 2>&1 || true; \
	fi

	@NETS=$$(docker network ls -q --filter "label=com.docker.compose.project=$(PROJECT_NAME)"); \
	if [ -n "$$NETS" ]; then \
		printf "\n➤ Removing project networks...\n"; \
		printf "$$NETS\n"; \
		echo "$$NETS" | xargs docker network rm -f >/dev/null 2>&1 || true; \
	fi

	@printf "\n$(GREEN)✓$(RESET) Reset complete.\n\n"

.PHONY: build
build: ## Build images. ENV=local|staging|production GPU=cpu|cuda|rocm IMAGE=<one image> DRY_RUN=1
	@yarn tsx scripts/xtask/index.ts build --env $(ENV) --gpu $(GPU) $(if $(DRY_RUN),--dry-run) $(IMAGE)

.PHONY: dbclear
dbclear: ## Clear the data stored in the PostgreSQL database
	@printf "$(call task_icon,dbclear,🧻) Clearing PostgreSQL data...\n\n"

	@cd backend/apps/api && yarn db:clear

	@printf "\n"

.PHONY: dbdestroy
dbdestroy: ## Drop all PostgreSQL data including tables
	@printf "$(call task_icon,dbdestroy,🧨) Destroying PostgreSQL database...\n\n"

	@cd backend/apps/api && yarn db:destroy

	@printf "\n"

.PHONY: dbshell
dbshell: ## Open a psql shell to the PostgreSQL database
	@yarn workspace @ci/be-api dbshell

.PHONY: dburl
dburl: ## Print this worktree's PostgreSQL connection URL (for DataGrip, psql, etc.)
	@yarn workspace @ci/be-api dburl

.PHONY: url
url: ## Print this worktree's stack URL
	@echo "https://$(PROJECT_NAME).localhost"

.PHONY: urls
urls: ## Show the URLs this worktree's running stack serves (read live from Caddy)
	@yarn tsx scripts/dev-stack/urls.ts --key $(PROJECT_NAME)

.PHONY: dev
dev: ## Run the development environment locally
	@yarn tsx scripts/xtask/index.ts dev --gpu $(GPU) $(if $(REBUILD),--rebuild)

.PHONY: fed-up
fed-up: ## Federation harness: bring two CI-Server boxes + a local OIDC issuer up
	@printf "$(call task_icon,fed-up,🤝) Starting the two-box federation harness...\n\n"

	@yarn fed up

.PHONY: fed-seed
fed-seed: ## Federation harness: owners, peer links, standing grants, fixture calendar
	@yarn fed seed

.PHONY: fed-run
fed-run: ## Federation harness: drive the five federated-ask scenarios (asserts; non-zero on violation)
	@yarn fed run

.PHONY: fed-demo
fed-demo: ## Federation harness: bring both boxes up and run every scenario
	@printf "$(call task_icon,fed-demo,🤝) Two Companions, one question at a time...\n\n"

	@yarn fed demo

.PHONY: fed-status
fed-status: ## Federation harness: what is running, and where the logs are
	@yarn fed status

.PHONY: fed-real-data
fed-real-data: ## Federation harness: load a bounded, READ-ONLY subset of real data into the boxes
	@yarn fed import-real-data $(ARGS)

.PHONY: fed-down
fed-down: ## Federation harness: stop both boxes (PURGE=1 also drops their databases)
	@yarn fed down $(if $(PURGE),--purge,)

.PHONY: dev-down
dev-down: ## Deregister this worktree's Caddy route (clears a stale route)
	@yarn tsx scripts/dev-stack/index.ts down --key $(PROJECT_NAME)

.PHONY: oauth
oauth: ## Point the canonical OAuth host at this worktree's running stack (replaces any prior claim)
	@yarn tsx scripts/dev-stack/oauth.ts up --key $(PROJECT_NAME)

.PHONY: oauth-down
oauth-down: ## Release the canonical OAuth host claim
	@yarn tsx scripts/dev-stack/oauth.ts down --key $(PROJECT_NAME)

.PHONY: tunnel
tunnel: ## Expose this running stack at https://dev.companionintelligence.com via Cloudflare Tunnel (see infrastructure/cloudflare/README.md)
	@# Refuse while .env holds the replace-me- placeholders from .env.default: a
	@# stack signing tokens and running its object store with committed values is
	@# open to anyone who has read the repo once it is on the internet.
	@yarn tsx scripts/dev-stack/env-secrets-cli.ts check .env
	@command -v cloudflared >/dev/null 2>&1 || { printf "$(RED)cloudflared not found — run: brew install cloudflared$(RESET)\n"; exit 1; }
	@test -f infrastructure/cloudflare/config.yml || { printf "$(RED)Missing infrastructure/cloudflare/config.yml — copy infrastructure/cloudflare/config.example.yml and fill it in (see README.md)$(RESET)\n"; exit 1; }
	@printf "$(YELLOW)Exposing https://dev.companionintelligence.com publicly — confirm Cloudflare Access is enabled. Ctrl-C to stop.$(RESET)\n"
	cloudflared tunnel --config infrastructure/cloudflare/config.yml run

.PHONY: format
format: ## Format the source, both stacks
	@printf "$(call task_icon,format,🧹) Formatting source...\n\n"

	@yarn format

	@printf "\n"

	@uv run ruff format .
	@uv run ruff check --fix .

	@printf "\nSource successfully formatted.\n\n"

.PHONY: graphql
graphql: ## Generate GraphQL schema and frontend types
	@printf "$(call task_icon,graphql,🏷️) Generating GraphQL...\n"

	@yarn workspace @ci/be-api graphql:generate

	@printf "\n"

	@yarn workspace @ci/fe-web graphql:generate

	@printf "\nGraphQL successfully generated.\n\n"

.PHONY: health
health: ## Check the repository for prerequisites
	@printf "$(call task_icon,health,🩺) Checking repository health...\n\n"

	@NODEJS=$$(which node 2>/dev/null); \
	if [ -z "$$NODEJS" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'node' installed or it is not in your path. Please install NodeJS v$(shell cat .nvmrc 2>/dev/null || echo '[unknown]') first.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) NodeJS found at $$NODEJS\n\n"; \
	fi

	@required_version=$$(cat .nvmrc); \
	current_version=$$(node -v | cut -c2-); \
	if [ "$$current_version" != "$$required_version" ]; then \
		printf "$(RED)✗$(RESET) Node version mismatch. Expected $$required_version, but got $$current_version.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) Node version matches ($$current_version)\n\n"; \
	fi

	@required_yarn=$$(grep '"packageManager"' package.json | sed 's/.*yarn@\([^"]*\)".*/\1/'); \
	current_yarn=$$(yarn --version 2>/dev/null); \
	if [ -z "$$current_yarn" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'yarn' installed or it is not in your PATH.\n\n"; \
		exit 1; \
	elif [ "$$current_yarn" != "$$required_yarn" ]; then \
		printf "$(RED)✗$(RESET) Yarn version mismatch. Expected $$required_yarn, but got $$current_yarn.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) Yarn version matches ($$current_yarn)\n\n"; \
	fi

	@# uv provisions its own interpreter from .python-version, so there is no
	@# separate Python check here. The floor is `required-version` in
	@# pyproject.toml, which uv enforces itself on every invocation.
	@UV=$$(which uv 2>/dev/null); \
	if [ -z "$$UV" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'uv' installed or it is not in your path. Install it with 'brew install uv'.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) uv found at $$UV ($$(uv --version | cut -d' ' -f2))\n\n"; \
	fi

	@# `vips` (libvips-tools) is the image decoder behind previews, dimensions
	@# and the vision renditions — the API shells out to it, so the host running
	@# the API needs it, and a missing binary fails every image job loudly.
	@VIPS=$$(which vips 2>/dev/null); \
	if [ -z "$$VIPS" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'vips' installed or it is not in your path. Install it with 'sudo apt install libvips-tools' (Debian/Ubuntu) or 'brew install vips' (macOS).\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) vips found at $$VIPS ($$(vips --version 2>/dev/null | sed 's/^vips-//'))\n\n"; \
	fi

	@# A present `vips` is not enough: it must also decode HEVC, the codec
	@# inside every iPhone HEIC. Debian and Homebrew link that decoder into
	@# libheif; Ubuntu 24.04 (and Mint 22) ship it as a separate plugin package
	@# that the current libheif1 no longer depends on, so a fresh install opens
	@# the container and then fails every tile. Decode the repo's HEIC test
	@# fixture the way VipsService does. `vips` exits 0 on that failure and
	@# writes a black image, so the verdict is the tile warnings on stderr.
	@# vips saves by suffix and BSD mktemp -t appends its own, hence DIR/out.jpg.
	@HEIC=backend/apps/api/src/domains/files/services/__tests__/__fixtures__/64x40.heic; \
	DIR=$$(mktemp -d) || exit 1; \
	OUT=$$DIR/out.jpg; \
	ERR=$$(vips thumbnail "$$HEIC[fail-on=error]" "$$OUT" 64 2>&1); STATUS=$$?; \
	rm -rf "$$DIR"; \
	if [ $$STATUS -ne 0 ] || printf '%s' "$$ERR" | grep -qE 'error in tile|Unsupported codec'; then \
		printf "$(RED)✗$(RESET) vips cannot decode HEIC (no HEVC decoder in libheif). On Ubuntu 24.04 / Mint 22 install it with 'sudo apt install libheif-plugin-libde265'; on Debian and macOS it comes with libvips-tools / brew vips.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) vips decodes HEIC (HEVC decoder present)\n\n"; \
	fi

	@# The pre-commit guards must actually FIRE in a linked worktree. `yarn
	@# prepare` (husky, see package.json) points core.hooksPath at `.husky/_` —
	@# a RELATIVE path, which git resolves against the root of the working tree
	@# the hook runs in. That directory only exists in the checkout husky was
	@# installed in, and it is gitignored, so every `git worktree add` produces
	@# a tree where core.hooksPath names a directory that is simply not there.
	@# Git's response to that is to run NO hooks at all, with no message —
	@# which is exactly where parallel agent work happens. Everything
	@# .husky/pre-commit drives goes with it: the Info.plist duplicate-key
	@# check, the Capacitor native-sync check, and bin/check-migration-versions.js,
	@# the guard that stops two branches committing the same dbmate timestamp
	@# prefix and breaking `yarn migrate` for everyone.
	@#
	@# Repair by pinning an ABSOLUTE hooksPath in this worktree's own config.
	@# `git config --worktree` (not --local) is what makes it stick: the value
	@# lands in this worktree's .git/config.worktree and outranks the shared
	@# one, so the next `yarn prepare` in the main checkout cannot reset it to
	@# the relative form. husky's `_/h` derives the script it runs from its own
	@# location (dirname of dirname of $$0), so pointing at the main checkout's
	@# .husky/_ runs the main checkout's .husky/pre-commit — and git runs hooks
	@# with the cwd set to THIS worktree's root, so lint-staged still sees this
	@# worktree's staged files.
	@#
	@# Warn, never fail. `dev` calls `health` from its recipe and `production`
	@# and `staging` take it as a prerequisite (`publish` does not — it depends
	@# on `init` alone), so a non-zero exit here refuses to start a stack, and a
	@# missing hook is not a reason to do that.
	@hooks=$$(git config --get core.hooksPath 2>/dev/null); \
	if [ -z "$$hooks" ]; then \
		printf "$(GREEN)✓$(RESET) git hooks: repository default (no core.hooksPath override)\n\n"; \
	else \
		case "$$hooks" in \
			/*) resolved="$$hooks" ;; \
			*) resolved="$$(git rev-parse --show-toplevel 2>/dev/null)/$$hooks" ;; \
		esac; \
		main_hooks="$$(cd "$$(dirname "$$(git rev-parse --git-common-dir 2>/dev/null)")" 2>/dev/null && pwd)/.husky/_"; \
		if [ -f "$$resolved/pre-commit" ]; then \
			printf "$(GREEN)✓$(RESET) git hooks resolve ($$resolved)\n\n"; \
		elif [ -f "$$main_hooks/pre-commit" ] && git config extensions.worktreeConfig true && git config --worktree core.hooksPath "$$main_hooks"; then \
			printf "$(YELLOW)•$(RESET) core.hooksPath was '$$hooks', which does not exist in this worktree — commits here were running NO pre-commit checks.\n"; \
			printf "  Repaired: this worktree now uses $$main_hooks\n\n"; \
		else \
			printf "$(YELLOW)•$(RESET) core.hooksPath is '$$hooks', which does not exist here, so commits in this worktree run NO pre-commit checks\n"; \
			printf "  (no migration-version guard, no plist or Capacitor sync check). Repair it with either:\n"; \
			printf "    $(YELLOW)yarn prepare$(RESET)                                                  # re-creates .husky/_ in this worktree\n"; \
			printf "    $(YELLOW)git config extensions.worktreeConfig true$(RESET) && \\\\\n"; \
			printf "      $(YELLOW)git config --worktree core.hooksPath \"$$main_hooks\"$(RESET)\n\n"; \
		fi; \
	fi

	@# Report on per-stack data volumes (convention: <project>-local-*). Purely
	@# informational — flags volumes whose key has no live worktree so orphans
	@# from deleted worktrees are visible; never removes anything.
	@if docker volume ls >/dev/null 2>&1; then \
		main_root=$$(cd "$$(dirname "$$(git rev-parse --git-common-dir 2>/dev/null)")" 2>/dev/null && pwd); \
		active=$$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | while read -r p; do \
			if [ "$$p" = "$$main_root" ]; then echo "$(REPO)"; else echo "$(REPO)-$$(basename "$$p" | tr '[:upper:]' '[:lower:]')"; fi; \
		done); \
		vols=$$(docker volume ls -q --filter name="$(REPO)" 2>/dev/null | grep -- '-local-'); \
		total=$$(printf '%s\n' "$$vols" | grep -c .); \
		keys=$$(printf '%s\n' "$$vols" | sed -n 's/-local-.*//p' | sort -u); \
		stacks=$$(printf '%s\n' "$$keys" | grep -c .); \
		printf "$(BLUE)ⓘ$(RESET)  %s project data volume(s) across %s stack(s)\n\n" "$$total" "$$stacks"; \
		orphans=""; for k in $$keys; do echo "$$active" | grep -qxF "$$k" || orphans="$$orphans $$k"; done; \
		if [ -n "$$orphans" ]; then \
			orphan_vols=$$(for k in $$orphans; do docker volume ls -q --filter name="$$k-local-"; done | tr '\n' ' '); \
			n=$$(printf '%s' "$$orphan_vols" | wc -w | tr -d ' '); \
			printf "  $(YELLOW)•$(RESET) %s volume(s) with no live worktree:%s\n" "$$n" "$$orphans"; \
			printf "    remove a dead stack (its stopped containers + volumes) with:\n"; \
			for k in $$orphans; do \
				printf "      $(YELLOW)COMPOSE_PROJECT_NAME=%s docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local down -v$(RESET)\n" "$$k"; \
			done; \
			printf "\n"; \
		fi; \
	fi

.PHONY: init
init: ## Initialize repository after checkout
	@printf "$(call task_icon,init,🏗️) Initializing repository...\n\n"

	@corepack enable
	@corepack prepare yarn@$$(grep '"packageManager"' package.json | cut -d@ -f2 | tr -d '", ') --activate
	@which asdf >/dev/null && asdf reshim nodejs || printf "\n$(YELLOW)•$(RESET) asdf binary not found, skipping reshim step...\n\n"
	@hash -r

	@printf "\n"
	@scripts/gh-packages-auth.sh --install

	@printf "\n"
	@yarn sdks vscode

	@printf "\n"
	@yarn prepare

	@printf "\n"
	@# --locked, never a bare sync. A bare `uv sync` treats a stale uv.lock as
	@# something to REPAIR: it re-resolves against the live index and writes the
	@# new resolution back. `publish` depends on this target and only reaches
	@# `build`'s `uv lock --check` afterwards, so on a release runner the lock
	@# would be silently refreshed first and the freshness gate would then pass
	@# against a file this same run just rewrote — unreviewed dependency
	@# versions baked into the summary and hbpe images, and two publishes of one
	@# commit on different days quietly differing. A build must not mutate its
	@# own inputs; --locked makes a stale lock an error instead.
	@#
	@# For a developer whose lock is legitimately stale this is now a hard stop
	@# rather than an invisible fix. uv's own message names the remedy — run
	@# `uv lock`, review the resolution diff, commit it, and re-run. Reviewing
	@# that diff is the whole point.
	@uv sync --all-packages --locked

	@# A fresh .env gets its own random secrets, not the committed replace-me-
	@# placeholders: anyone with the repo can read those, and a dev stack is not
	@# always reachable from this machine alone (`make tunnel` publishes it).
	@# Only placeholders are replaced, and only here, on a file this run has just
	@# created, so an existing .env keeps the values its volumes were set up with.
	@# The database passwords and the field-encryption key are not placeholders
	@# and stay as committed (see scripts/dev-stack/env-secrets.ts). If a mint
	@# fails, the half-made .env is removed so the next run tries again.
	@if [ ! -f .env ]; then \
		printf "Creating .env from the dotenv template, with generated secrets...\n"; \
		cp .env.default .env && \
		yarn tsx scripts/dev-stack/env-secrets-cli.ts mint .env || { rm -f .env; exit 1; }; \
		printf "\n"; \
	fi

	@# The copy above happens once, so a key added to .env.default later never
	@# reaches an existing .env. SIDECAR_AUTH_SECRET is one the stack cannot boot
	@# without — the HBPE/Summary entrypoints exit 1 when it is empty, and so does
	@# the staging api — so mint one into a .env that predates it. A .env that
	@# already names the key (a fresh copy carries the template's) is left alone.
	@# scripts/dev-stack/sidecar-secret.ts does the same for a direct
	@# `yarn tsx scripts/dev-stack/index.ts up`, which never runs this target.
	@if [ -f .env ] && ! grep -q '^SIDECAR_AUTH_SECRET=' .env; then \
		printf "Adding a generated SIDECAR_AUTH_SECRET to .env...\n\n"; \
		printf '\n# Bearer the API presents to the HBPE/Summary sidecars; they refuse requests without it.\nSIDECAR_AUTH_SECRET=%s\n' \
			"$$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env; \
	fi

.PHONY: install
install: ## Install project dependencies
	@printf "$(call task_icon,install,📦) Installing dependencies...\n\n"

	@scripts/gh-packages-auth.sh --install

	@printf "\n"

	@# --locked for the same reason as `init` above: installing must never
	@# re-resolve and rewrite uv.lock behind the operator's back. If this stops
	@# with "the lockfile is not up-to-date", run `uv lock`, review the diff and
	@# commit it — that is the intended workflow, not a bug in this target.
	@uv sync --all-packages --locked

	@printf "\n"

.PHONY: lint
lint: ## Check the source for lint and formatting errors, both stacks
	@printf "$(call task_icon,lint,🔎) Checking formatting...\n\n"

	@yarn lint
	@yarn format:check

	@printf "\n"

	@uv run ruff check .
	@uv run ruff format --check .
	@uv run mypy

	@# Catches a uv.lock left stale after the merge driver kept one side
	@# (see scripts/merge-uv-lock.sh) or a manifest edit without a relock.
	@uv lock --check || { printf "$(RED)✗$(RESET) uv.lock is out of date with the manifests. Run 'uv lock' and retry.\n\n"; exit 1; }

	@sh scripts/check-ci-namespace.sh
	@node scripts/check-capacitor-native-sync.mjs

	@printf "\nNo lint errors found.\n\n"

.PHONY: typecheck
typecheck: ## Typecheck every JS/TS workspace that declares a typecheck script
	@printf "$(call task_icon,typecheck,🧾) Typechecking...\n\n"

	@# JS/TS only — Python types are already checked by `uv run mypy` in `make lint`.
	@#
	@# Until now the eight frontend/packages/* were never typechecked on their
	@# own: none of them declared a script, and `foreach` silently skips a
	@# workspace that has nothing to run. They were only ever checked as a side
	@# effect of `yarn workspace @ci/fe-web build` pulling their source through
	@# the bundler, which means a package with no importer in web was checked by
	@# nothing at all.
	@yarn workspaces foreach --all run typecheck

	@printf "\nTypes check out.\n\n"

.PHONY: test
test: ## Run the unit tests, both stacks
	@# `node --import tsx`, NOT `yarn tsx`: the tsx CLI wrapper relays Ctrl-C and `kill` to its child and
	@# SIGKILLs it if it has not answered within ~60 ms. This command spends its time blocked in a child
	@# process, so it cannot answer, and the run would die with no summary (and, for test-db, with a
	@# database container left running). scripts/xtask/makefile.test.ts fails if this goes back.
	@yarn node --import tsx scripts/xtask/index.ts test

.PHONY: test-db
test-db: ## Run the database-backed jest suites against a throwaway Postgres (needs Docker)
	@# `node --import tsx`, not `yarn tsx` -- see `test` above for why. Here the cost of the wrapper is a
	@# running ci-testdb-* container and a leftover temp dir.
	@yarn node --import tsx scripts/xtask/index.ts test-db $(if $(KEEP),--keep) $(if $(KEEP_FOR),--keep-for $(KEEP_FOR)) $(if $(WORKERS),--workers $(WORKERS)) $(if $(DB_IMAGE),--image $(DB_IMAGE)) $(if $(NO_RETRY),--no-retry) -- $(ARGS)

.PHONY: test-android
test-android: ## Run the Android native unit tests (JVM; no emulator needed)
	@printf "$(call task_icon,test-android,🤖) Running Android unit tests...\n\n"

	@# Kept out of `make test` on purpose: this needs a JDK $(ANDROID_JDK_MAJOR) and an Android
	@# SDK, which a backend-only machine has no reason to carry. Folding it in
	@# would turn `make test` red for everyone who never touches the app.
	@#
	@# Preconditions are checked the way `dev` checks overmind/caddy/ollama —
	@# name the missing thing and the command that fixes it, rather than let
	@# Gradle fail 300 lines later.
	@JAVA=$$(command -v java 2>/dev/null); \
	if [ -z "$$JAVA" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'java' installed or it is not in your PATH. The Android build needs JDK $(ANDROID_JDK_MAJOR) (point $(YELLOW)JAVA_HOME$(RESET) at one — Android Studio bundles a JBR).\n\n"; \
		exit 1; \
	fi; \
	major=$$(java -version 2>&1 | sed -n 's/^[a-zA-Z ]*version "\([0-9][0-9]*\).*/\1/p' | head -n1); \
	if [ "$$major" != "$(ANDROID_JDK_MAJOR)" ]; then \
		printf "$(RED)✗$(RESET) JDK version mismatch. Expected $(ANDROID_JDK_MAJOR) (AGP 8.7.2 and jvmTarget 21 accept nothing else), but got $${major:-unknown}. Point $(YELLOW)JAVA_HOME$(RESET) at a JDK $(ANDROID_JDK_MAJOR).\n\n"; \
		exit 1; \
	fi; \
	printf "$(GREEN)✓$(RESET) JDK $$major found at $$JAVA\n\n"

	@# The SDK's location is the machine's business, never this file's: honour
	@# ANDROID_HOME, then ANDROID_SDK_ROOT, then the sdk.dir Android Studio
	@# writes into the project's (git-ignored) local.properties. Nothing is
	@# guessed, and no path is hard-coded — an unset SDK is an error with a fix
	@# in it, not a default that silently points somewhere wrong.
	@SDK="$(android_sdk_dir)"; \
	if [ -z "$$SDK" ]; then \
		printf "$(RED)✗$(RESET) No Android SDK found. Set $(YELLOW)ANDROID_HOME$(RESET) (or ANDROID_SDK_ROOT) to your SDK root, or put $(YELLOW)sdk.dir=/path/to/sdk$(RESET) in $(ANDROID_APP_DIR)/local.properties.\n\n"; \
		exit 1; \
	elif [ ! -d "$$SDK" ]; then \
		printf "$(RED)✗$(RESET) Android SDK path '$$SDK' is not a directory. Fix $(YELLOW)ANDROID_HOME$(RESET) / ANDROID_SDK_ROOT.\n\n"; \
		exit 1; \
	elif [ ! -d "$$SDK/platforms/android-$(ANDROID_COMPILE_SDK)" ]; then \
		printf "$(RED)✗$(RESET) SDK at $$SDK has no $(YELLOW)platforms;android-$(ANDROID_COMPILE_SDK)$(RESET) (the project's compileSdk). Install it:\n"; \
		printf "    $(YELLOW)sdkmanager \"platform-tools\" \"platforms;android-$(ANDROID_COMPILE_SDK)\" \"build-tools;$(ANDROID_BUILD_TOOLS)\"$(RESET)\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) Android SDK at $$SDK (platforms;android-$(ANDROID_COMPILE_SDK))\n\n"; \
	fi

	@# The three :ci-capacitor-* modules reach the Gradle build through yarn
	@# `portal:` symlinks under this app's own node_modules, which a root PnP
	@# install does not materialize (see CLAUDE.md → Package manager). Without
	@# them, settings.gradle resolves nothing and the failure names a generated
	@# file instead of the missing install.
	@if [ ! -d $(ANDROID_APP_DIR)/../node_modules/@ci ]; then \
		printf "$(RED)✗$(RESET) $(ANDROID_APP_DIR)/../node_modules/@ci is missing — the native modules are not linked. Run $(YELLOW)yarn install$(RESET) inside frontend/apps/android (it is a standalone project, not a workspace).\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) Native plugin modules linked\n\n"; \
	fi

	@# `testDebugUnitTest` with no module prefix runs every module that has a
	@# unit-test source set, so a new plugin package is picked up without a line
	@# here — the same reasoning as `foreach --all` in `test` above. Instrumented
	@# (androidTest) suites are NOT here: they need a running device. Run those
	@# with `./gradlew connectedDebugAndroidTest` against a booted emulator.
	@cd $(ANDROID_APP_DIR) && ANDROID_HOME="$(android_sdk_dir)" ./gradlew testDebugUnitTest $(GRADLE_ARGS)

	@# Each module writes its own report, and three of the four modules live
	@# outside the app directory (they are pulled in over `portal:` symlinks),
	@# so name both roots rather than one glob that misses most of them.
	@printf "\n$(GREEN)✓$(RESET) Android unit tests passed. HTML reports:\n"
	@printf "    $(ANDROID_APP_DIR)/app/build/reports/tests/testDebugUnitTest/index.html\n"
	@printf "    frontend/packages/capacitor-*/android/build/reports/tests/testDebugUnitTest/index.html\n\n"

.PHONY: test-desktop
test-desktop: ## Run the desktop (Tauri/Rust) unit tests
	@printf "$(call task_icon,test-desktop,🖥️) Running desktop tests...\n\n"

	@CARGO=$$(command -v cargo 2>/dev/null); \
	if [ -z "$$CARGO" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'cargo' installed or it is not in your PATH. Install the Rust toolchain from https://rustup.rs.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) cargo found at $$CARGO ($$(cargo --version | cut -d' ' -f2))\n\n"; \
	fi

	@# Linux only: the crate links GTK/WebKit through *-sys build scripts, so the
	@# tests do not even COMPILE without the -dev packages — and the failure is
	@# 200 lines of build-script output that never names the package to install.
	@# pkg-config is exactly how those build scripts look, so ask it the same
	@# question first and answer with the apt line desktop-build.yml already uses.
	@if [ "$$(uname -s)" = "Linux" ]; then \
		if ! command -v pkg-config >/dev/null 2>&1; then \
			printf "$(RED)✗$(RESET) 'pkg-config' is not installed — the Rust *-sys build scripts need it to find GTK/WebKit.\n"; \
			printf "    $(YELLOW)sudo apt-get install -y $(DESKTOP_LINUX_APT_PACKAGES)$(RESET)\n\n"; \
			exit 1; \
		fi; \
		missing=""; \
		for pkg in $(DESKTOP_LINUX_PKGCONFIG); do \
			pkg-config --exists "$$pkg" 2>/dev/null || missing="$$missing $$pkg"; \
		done; \
		if [ -n "$$missing" ]; then \
			printf "$(RED)✗$(RESET) Missing system libraries for the Tauri crate:$$missing\n"; \
			printf "    $(YELLOW)sudo apt-get install -y $(DESKTOP_LINUX_APT_PACKAGES)$(RESET)\n"; \
			printf "    (or set $(YELLOW)PKG_CONFIG_PATH$(RESET) if they live outside the default search path)\n\n"; \
			exit 1; \
		else \
			printf "$(GREEN)✓$(RESET) GTK/WebKit development libraries found\n\n"; \
		fi; \
	fi

	@cd $(DESKTOP_TAURI_DIR) && cargo test $(CARGO_ARGS)

	@printf "\n$(GREEN)✓$(RESET) Desktop tests passed.\n\n"

.PHONY: migrate
migrate: ## Run database migrations
	@printf "$(call task_icon,migrate,🪿) Running database migrations...\n\n"

	@cd backend/apps/api && yarn migrate

	@printf "\nMigrations successfully run.\n\n"

.PHONY: production
production: health init ## Run the production deployment
	@$(MAKE) build ENV=production GPU=$(GPU)

	$(call switch_env,production)

	@printf "$(call task_icon,production,🚀) Starting production services...\n\n"

	@docker compose -f docker-compose.yml -f docker-compose.production.yml --profile production up -d --remove-orphans

	@printf "\n"

.PHONY: smoke-api
smoke-api: ## Verify the API image can run `migrate` with production-only dependencies
	@printf "$(call task_icon,smoke-api,🔍) Smoke-testing API image...\n\n"

# migrate-database runs `yarn migrate`, so both halves of it must resolve inside
# the image, which installs dependencies only: a devDependency in either exits
# non-zero at startup and rolls back every app install. Neither half needs a
# database here — check:migrations only reads the migration files, and the dbmate
# half runs `--no-wait` in a container with no network, so the wrapper's ownership
# check finds nothing to connect to and steps aside. entrypoint.sh is bypassed
# because it demands the eight runtime secrets. A missing image is an error, not
# a pass: a gate that verified nothing must not report green.
#
# The dbmate half goes through yarn, the way migrate does, and asks the binary for
# its `--version`:
#   - bin/dbmate.js spawns a bare `dbmate`, and the only one in the image is the
#     npm package's, which yarn puts first on the PATH of the scripts it runs. A
#     bare `node bin/dbmate.js` skips yarn, so it would test a different
#     resolution than production uses — it once reached a curl-installed 2.27.0
#     that migrate never ran.
#   - `--help` is answered by the wrapper's own argument parser, which exits before
#     it spawns anything, so it passes with no dbmate in the image at all.
#     `--version` is forwarded to the binary, so a missing or wrong-architecture
#     one fails here rather than in migrate-database on an appliance.
	@docker image inspect $(API_REPO):latest >/dev/null 2>&1 || { \
		printf "  ✗ $(API_REPO):latest not found — run 'make build' first.\n\n"; \
		exit 1; \
	}

	@docker run --rm --network none --entrypoint sh $(API_REPO):latest -c \
		'yarn check:migrations && yarn dbmate --no-wait --version'

	@printf "\nAPI image can migrate. ✅\n\n"

# `smoke-api` above proves one process can resolve its imports. It never BOOTS
# the API, so until this target existed nothing in the repo started the
# assembled stack from the images `build` had just produced: Nest's dependency
# graph, entrypoint.sh's secrets loading, the migration run against a fresh
# database and infrastructure/gateway/nginx.conf were all first exercised by a
# user at first launch, on the appliance, after the images shipped.
#
# Deliberately a THROWAWAY compose project, not $(PROJECT_NAME): this target
# ends in `down -v`, and sharing the project name with a real stack would
# delete that stack's ${COMPOSE_PROJECT_NAME}-production-db-data volume.
SMOKE_PROJECT_NAME := $(PROJECT_NAME)-smoke

# Seconds to wait for the gateway to answer /api/health once the containers are
# up. Bump it on a cold machine where the first migration run is slow.
SMOKE_TIMEOUT ?= 120

# Seconds to leave the worker running before judging it healthy. The worker has
# `restart: unless-stopped`, so a process that dies at DI-graph construction
# comes straight back and a snapshot taken immediately after `up -d` sees a
# "Running" container either way. Waiting lets the crash loop show itself in the
# restart count.
#
# That count is read as `{{.RestartCount}}`, NOT `{{.State.RestartCount}}`:
# docker puts it at the TOP LEVEL of the inspect object, a sibling of `State`.
# The wrong path does not read empty — text/template aborts the whole render
# with `map has no entry for key "RestartCount"` and exits non-zero, which is
# how the first run of this check took `make publish` down with it instead of
# reporting on the worker.
SMOKE_WORKER_WATCH ?= 30

# What counts as "the worker did not boot cleanly", as an ERE for grep -Ei.
# These are the fingerprints of the two DI faults docs/qa/release-qa-program.md
# §6.4/§6.4b records — a duplicate FileService provider and an import-barrel
# cycle — both of which shipped because the unit tests stub the providers and so
# could not fail, and both of which were found only by running the app:
#   ExceptionHandler / "Nest can't resolve" — Nest's own boot-time DI failure
#   is not a function                      — the barrel-cycle symptom exactly
#                                            (`this.ollamaService.chat is not a
#                                            function`)
#   unhandledRejection                     — anything that escaped a handler
# Apostrophe written as `.` so the value needs no quoting inside the recipe.
SMOKE_WORKER_FATAL_RE ?= ExceptionHandler|Nest can.t resolve|UnhandledPromiseRejection|unhandledRejection|is not a function

# The compose invocation the smoke uses everywhere, including in its teardown
# trap. CI_IMPORT_WORK_DIR / CI_REPO_DIR are redirected at $SMOKE_TMP (set by
# the recipe) because their defaults are `./import-work` and `~/Downloads`:
# docker CREATES a missing bind source, so the defaults would drop an untracked
# import-work/ into the repo root on every publish.
SMOKE_COMPOSE = COMPOSE_PROJECT_NAME=$(SMOKE_PROJECT_NAME) \
	CI_IMPORT_WORK_DIR="$$SMOKE_TMP/import-work" CI_REPO_DIR="$$SMOKE_TMP/repo" \
	docker compose -f docker-compose.yml -f docker-compose.production.yml --profile production

.PHONY: smoke-stack
smoke-stack: ## Boot the built production images and prove the gateway serves the API, the SPA and a healthy worker
	@printf "$(call task_icon,smoke-stack,🚦) Smoke-testing the assembled production stack...\n\n"

# Every image the smoke touches must already exist locally. Compose would
# otherwise try to PULL ci/api from a registry, and a green run would then say
# nothing about what `build` just produced — the same "a gate that verified
# nothing must not report green" rule smoke-api follows above.
	@for img in $(API_REPO) $(GATEWAY_REPO) $(DATABASE_REPO) $(OBJECT_STORE_REPO) $(SETUP_DATABASE_REPO) $(SETUP_SECRETS_REPO); do \
		docker image inspect "$$img:latest" >/dev/null 2>&1 || { \
			printf "  $(RED)✗$(RESET) $$img:latest not found — run 'make build ENV=production' first.\n\n"; \
			exit 1; \
		}; \
	done

# nginx resolves `upstream api { server api:3030; }` and the object-store
# proxy_pass at CONFIG LOAD time, so a bare `nginx -t` outside the compose
# network dies with "host not found in upstream" and tells you nothing about
# the config itself. The two --add-host entries give those names something to
# resolve to; what is under test is nginx.conf's syntax and directives, not
# connectivity. Seconds of work, and it fails here instead of as a
# crash-looping gateway on someone's appliance.
	@printf "➤ Validating the gateway's nginx.conf...\n\n"
	@docker run --rm --add-host api:127.0.0.1 --add-host object-store:127.0.0.1 \
		--entrypoint nginx $(GATEWAY_REPO):latest -t

# docker-compose.production.yml publishes the gateway on a FIXED host port, so
# anything already holding 8642 (a running `make production`, the desktop app)
# turns this into an opaque bind failure. Name it up front. `nc` is only
# advisory here — skip the check rather than fail when it is absent.
	@if command -v nc >/dev/null 2>&1 && nc -z localhost 8642 >/dev/null 2>&1; then \
		printf "\n  $(RED)✗$(RESET) Port 8642 is already in use — stop whatever holds it ('make stop') and retry.\n\n"; \
		exit 1; \
	fi

# One shell for boot + poll + teardown, so the trap owns the containers for the
# whole span: the stack comes down on success, on a failed assertion, and on a
# Ctrl-C, and a leaked stack can never sit on 8642 and poison the next run.
#
# EVERY command in the teardown ends in `|| true`, the `rm` included, and that
# is load-bearing rather than tidy: under `set -e` a failing LAST command in an
# EXIT trap becomes the shell's exit status, so an unguarded teardown error
# both masks a real health failure AND turns a fully passing smoke into a
# failed `make publish`. The `rm` is the one that actually trips: on a rootful
# daemon docker creates a missing bind source as root, and the api creates
# inbox/ under /var/lib/ci-import at startup (see the mount comment in
# docker-compose.production.yml) — so the leftovers are root-owned and `rm -rf`
# exits 1 with "Permission denied". Pre-creating the two bind sources below
# keeps that parent directory owned by the invoking user, which is what lets
# the trap remove the empty root-owned children it finds inside; `|| true`
# covers the case where it still cannot, at the cost of one stray mktemp dir.
#
# `gateway` and `worker` are named, so compose starts those two dependency
# closures — object-store, api, and through both of them generate-secrets,
# migrate-database and database. hbpe-service, summary-service and powersync
# stay down: they are not what is under test, and hbpe would drag GPU device
# nodes and a model download into a release gate. setup-database runs first and
# synchronously (`run` waits and propagates the exit code) because it creates
# the application role and database that migrate-database then connects as, and
# nothing in the compose graph orders those two.
#
# `worker` is here — it used to be in the "stay down" list — because it is the
# ONLY thing in this repo that boots the real module graph in the shape the two
# defects in docs/qa/release-qa-program.md §6.4/§6.4b took: a duplicate provider
# and an import-barrel cycle, both invisible to the unit tests (which stub the
# providers) and both found by running the app. It is the same ci/api image with
# CI_ROLE=worker, so it costs one more container and no new image, and unlike
# the api it constructs the eleven `role: 'worker'` schedules. Watching it for
# $(SMOKE_WORKER_WATCH)s is a boot-time check: it catches a graph that cannot be
# constructed, NOT a fault that only fires when a cron later runs (the
# barrel-cycle bug's actual trigger). Widen SMOKE_WORKER_WATCH, or trigger a
# job, if you want the latter too.
#
# The /api/health poll is necessary and not sufficient: nginx PROXIES that path
# to the api container, so it is green whenever the API is green and says
# nothing at all about the gateway's own payload. Until the GET / assertions
# below existed, a gateway image whose web root was empty or stale passed this
# target and printed success — and an empty root is a realistic build outcome,
# because infrastructure/gateway/Dockerfile is a bare
# `COPY frontend/apps/web/dist /usr/share/nginx/html/ci/web` and COPY of an
# empty-but-present directory succeeds silently. So: GET / must be 200, must
# carry the SPA shell's `id="root"` div, and must reference at least one hashed
# /assets/ bundle that the gateway then actually serves. The last check is the
# one that separates "shipped a Vite build" from "shipped the dev index.html".
#
# NOTE for anyone editing the block below: it is ONE `\`-continued shell line,
# so a `#` shell comment inside it would comment out everything after it. Put
# rationale up here at column 0 instead.
	@set -e; \
	SMOKE_TMP=$$(mktemp -d); \
	mkdir -p "$$SMOKE_TMP/import-work" "$$SMOKE_TMP/repo"; \
	trap '$(SMOKE_COMPOSE) down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$$SMOKE_TMP" 2>/dev/null || true' EXIT INT TERM; \
	printf "\n➤ Creating the application role and database...\n\n"; \
	$(SMOKE_COMPOSE) run --rm -T setup-database; \
	printf "\n➤ Starting database, api, worker and gateway from the local images...\n\n"; \
	$(SMOKE_COMPOSE) up -d gateway worker || { \
		printf "\n  $(RED)✗$(RESET) The stack did not start. Logs:\n\n"; \
		$(SMOKE_COMPOSE) logs --tail 80 || true; \
		exit 1; \
	}; \
	printf "\n➤ Polling http://localhost:8642/api/health (up to $(SMOKE_TIMEOUT)s)...\n\n"; \
	deadline=$$(( $$(date +%s) + $(SMOKE_TIMEOUT) )); \
	until curl -fsS http://localhost:8642/api/health >/dev/null 2>&1; do \
		if [ "$$(date +%s)" -ge "$$deadline" ]; then \
			printf "  $(RED)✗$(RESET) The gateway never answered /api/health within $(SMOKE_TIMEOUT)s. Logs:\n\n"; \
			$(SMOKE_COMPOSE) logs --tail 80 api gateway || true; \
			exit 1; \
		fi; \
		sleep 2; \
	done; \
	printf "$(GREEN)✓$(RESET) gateway served /api/health from the built images\n"; \
	printf "\n➤ Asserting the gateway serves the web app, not an empty root...\n\n"; \
	curl -fsS -o "$$SMOKE_TMP/index.html" http://localhost:8642/ || { \
		printf "  $(RED)✗$(RESET) GET / did not return 200 — the gateway image has no web root. infrastructure/gateway/Dockerfile COPYs frontend/apps/web/dist, and COPY of an empty-but-present directory SUCCEEDS, so this is what a gateway built without a web build looks like. Rebuild with 'make build ENV=production'. Logs:\n\n"; \
		$(SMOKE_COMPOSE) logs --tail 40 gateway || true; \
		exit 1; \
	}; \
	grep -q 'id="root"' "$$SMOKE_TMP/index.html" || { \
		printf "  $(RED)✗$(RESET) GET / returned 200 but the body is not the SPA shell — no <div id=\"root\"> (see frontend/apps/web/index.html; Vite leaves that div untouched, so its absence means the served file is not our index.html at all). First 20 lines:\n\n"; \
		head -n 20 "$$SMOKE_TMP/index.html" || true; \
		printf "\n"; \
		exit 1; \
	}; \
	asset=$$(grep -o '/assets/[A-Za-z0-9._-]\{1,\}' "$$SMOKE_TMP/index.html" | head -n 1); \
	if [ -z "$$asset" ]; then \
		printf "  $(RED)✗$(RESET) The served index.html references no /assets/ bundle, so nothing would ever mount into #root. An UNBUILT index.html (script src=/src/main.tsx) was shipped instead of a Vite build.\n\n"; \
		exit 1; \
	fi; \
	curl -fsS -o /dev/null "http://localhost:8642$$asset" || { \
		printf "  $(RED)✗$(RESET) index.html references $$asset but the gateway will not serve it — nginx.conf's /assets/ location is 'try_files \$$uri = 404', so the web root is stale or partially copied.\n\n"; \
		exit 1; \
	}; \
	printf "$(GREEN)✓$(RESET) gateway served the SPA shell and its hashed bundle $$asset\n"; \
	printf "\n➤ Watching the worker for $(SMOKE_WORKER_WATCH)s...\n\n"; \
	sleep $(SMOKE_WORKER_WATCH); \
	worker_cid=$$($(SMOKE_COMPOSE) ps -aq worker); \
	if [ -z "$$worker_cid" ]; then \
		printf "  $(RED)✗$(RESET) There is no worker container — it never started. Logs:\n\n"; \
		$(SMOKE_COMPOSE) logs --tail 80 worker || true; \
		exit 1; \
	fi; \
	worker_state=$$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$$worker_cid") || { \
		printf "  $(RED)✗$(RESET) Could not inspect the worker container ($$worker_cid). Logs:\n\n"; \
		$(SMOKE_COMPOSE) logs --tail 80 worker || true; \
		exit 1; \
	}; \
	if [ "$$worker_state" != "true 0" ]; then \
		printf "  $(RED)✗$(RESET) The worker did not stay up for $(SMOKE_WORKER_WATCH)s (Running/RestartCount = '$$worker_state', wanted 'true 0'). 'restart: unless-stopped' means a crash loop still shows a Running container, which is why the restart count is checked too. Logs:\n\n"; \
		$(SMOKE_COMPOSE) logs --tail 80 worker || true; \
		exit 1; \
	fi; \
	if $(SMOKE_COMPOSE) logs --no-color worker 2>&1 | grep -Eqi "$(SMOKE_WORKER_FATAL_RE)"; then \
		printf "  $(RED)✗$(RESET) The worker is up but logged a fatal-looking error while constructing the real module graph:\n\n"; \
		$(SMOKE_COMPOSE) logs --no-color worker 2>&1 | grep -Ei "$(SMOKE_WORKER_FATAL_RE)" | head -n 20 || true; \
		printf "\n"; \
		exit 1; \
	fi; \
	printf "$(GREEN)✓$(RESET) worker stayed up $(SMOKE_WORKER_WATCH)s with no DI or unhandled-rejection errors in its log\n"

	@printf "\nProduction stack boots, serves the web app, and keeps a worker alive. ✅\n\n"

.PHONY: publish
publish: publish-build ## Publish CI-Server images and metadata to the CI-Portal store
	@printf "$(call task_icon,publish,📦) Publishing to CI-Portal registry...\n\n"

	@scripts/publish/publish.sh

	@printf "\n"

# Everything `publish` does before it pushes. publish.yml's build job runs this
# on its own, with a read-only token, and hands the images to a separate push
# job: `init` runs every allowed dependency install script and `uv sync`, and
# none of that code should share a job with the registry write token.
.PHONY: publish-build
publish-build: init ## Build and smoke-test the production images without pushing them
	@$(MAKE) build ENV=production GPU=$(GPU)

	@$(MAKE) smoke-api

	@# smoke-api only proves the image's imports resolve. This one boots the
	@# stack it is about to publish and requires a real 200 from the gateway on
	@# BOTH /api/health and the SPA shell, plus a worker that survives its own
	@# DI graph — so a DI fault, a broken entrypoint, a bad nginx.conf or a
	@# gateway image with an empty web root stops the release here rather than
	@# at a user's first launch.
	@$(MAKE) smoke-stack

.PHONY: publish-quiet
publish-quiet: ## Publish to CI-Portal store (quiet mode)
	@scripts/publish/publish.sh -q

.PHONY: seed
seed: ## Seed database with demo data (SEED_USER_ID=<uuid> to target an existing user)
	@printf "$(call task_icon,seed,🌱) Seeding database for user $(SEED_USER_ID)...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts

	@printf "\nDatabase successfully seeded. 🌳\n\n"

.PHONY: predict
predict: ## Run the HBPE prediction pipeline against the local container
	@printf "$(call task_icon,predict,🔮) Running HBPE prediction pipeline (local)...\n\n"

	@docker exec ci-server-hbpe-service-1 python3 scripts/run_pipeline.py $(JOHN_SMITH_USER_ID)

	@printf "\nPipeline run complete.\n\n"

.PHONY: predict-production
predict-production: ## Run the HBPE prediction pipeline against the production container
	@printf "$(call task_icon,predict-production,🔮) Running HBPE prediction pipeline (production)...\n\n"

	@docker exec ci-server-hbpe-service-1 \
		sh -c 'export $$(cat /proc/$$(pgrep -f "ci.worker" | head -1)/environ | xargs -0 | grep DATABASE_URL) \
		&& python3 scripts/run_pipeline.py $(JOHN_SMITH_USER_ID)'

	@printf "\nPipeline run complete.\n\n"

.PHONY: seed-production
seed-production: ## Seed production database via ephemeral proxy
	@printf "$(call task_icon,seed-production,🌱) Seeding production database...\n\n"

	@docker compose -f docker-compose.yml -f docker-compose.production.yml --profile tooling up -d dbproxy >/dev/null 2>&1
	@CONNSTR=$$(docker compose -f docker-compose.yml -f docker-compose.production.yml --profile tooling run --rm dbconnstr 2>/dev/null) && \
	DATABASE_HOST=localhost DATABASE_PORT=5432 \
	DATABASE_USERNAME=$$(echo "$$CONNSTR" | sed 's|postgresql://\([^:]*\):.*|\1|') \
	DATABASE_PASSWORD=$$(echo "$$CONNSTR" | sed 's|postgresql://[^:]*:\([^@]*\)@.*|\1|') \
	sh -c 'cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts'; \
	EXIT=$$?; \
	docker compose -f docker-compose.yml -f docker-compose.production.yml --profile tooling stop dbproxy >/dev/null 2>&1; \
	exit $$EXIT

	@printf "\nDatabase successfully seeded. 🌳\n\n"

.PHONY: staging
staging: health init ## Run the staging deployment
	@$(MAKE) build ENV=staging GPU=$(GPU)

	$(call switch_env,staging)

	@printf "$(call task_icon,staging,🎭) Starting staging services...\n\n"

	@docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile staging up -d --remove-orphans

	@printf "\n"

.PHONY: stop
stop: ## Stop all running services
	@printf "➤ Stopping all running services... "

	@docker compose -f docker-compose.yml --profile tooling down 2>/dev/null || true
	@docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local down 2>/dev/null || true
	@docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile staging down 2>/dev/null || true
	@docker compose -f docker-compose.yml -f docker-compose.production.yml --profile production down 2>/dev/null || true

	@printf "success!\n\n"

.PHONY: tooling
tooling: ## Run development tooling services
	@printf "$(call task_icon,tooling,🛠️) Starting development tooling services...\n\n"

	@docker compose -f docker-compose.yml --profile tooling up -d

	@printf "\n"

#####################
# API ADMIN SCRIPTS #
#####################

.PHONY: gentoken
gentoken: ## Generates a stable access token for use during development
	@printf "$(call task_icon,gentoken,🔑) Generating stable access token...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/generate-stable-access-token.ts

	@printf "\n"

.PHONY: signup
signup: ## Generates a set of signup codes for user registration
	@printf "$(call task_icon,signup,👋) Generating signup codes...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/generate-signup-codes.ts

.PHONY: testuser
testuser: ## Create a local user and print a fresh API key for it
	@printf "$(call task_icon,testuser,🧑‍🔬) Creating test user and API key...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/create-test-user.ts

	@printf "\n"

.PHONY: userpw
userpw: ## Change a user's password
	@printf "$(call task_icon,userpw,🔑) Changing user password...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/change-password.ts

	@printf "\n"

.PHONY: hub-account-link
hub-account-link: ## Show or repair which Memory account each Hub person signs in as (ARGS="list" | "move --from A --to B [--apply]" | "unlink --email A [--apply]")
	@printf "$(call task_icon,hub-account-link,🔗) Hub account links...\n\n"

	@cd backend/apps/api && yarn hub-account-link $(or $(ARGS),list)

	@printf "\n"

.PHONY: chatreset
chatreset: ## Reset John Smith's demo threads
	@printf "$(call task_icon,chatreset,🧹) Resetting John Smith's demo threads...\n\n"

	@cd backend/apps/api && yarn db:chatreset

	@printf "\n"

.PHONY: filereset
filereset: ## Clear all files from the system
	@printf "$(call task_icon,filereset,🧹) Clearing all files from the system...\n\n"

	@cd backend/apps/api && yarn db:filereset

	@printf "\n"
