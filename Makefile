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

# Seed user UUID (John Smith) — must match backend/apps/api/scripts/seed-database/data/users.ts
JOHN_SMITH_USER_ID := b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b

export TAG ?= $(shell git describe --tags --exact-match 2>/dev/null)

# Ollama models the stack cannot run without: the embedding model
# (`embedding.model` in backend/apps/api/config/default.json) and the chat model
# every LLM-backed feature falls back to (`DEFAULT_CHAT_MODEL` in
# backend/apps/api/src/configuration.ts). `dev` pulls any that are missing
# rather than refusing to boot — a first run on a fresh machine is a download,
# not an error. Keep this list in step with those two sources of truth.
REQUIRED_OLLAMA_MODELS := nomic-embed-text gemma4:e4b

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
ANDROID_COMPILE_SDK := 35
ANDROID_BUILD_TOOLS := 35.0.0

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

# Helper: expands to "-t repo:tag" only when TAG is non-empty
versioned_tag = $(if $(TAG),-t $(1):$(TAG))

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
seed migrate dbclear dbdestroy dbshell dburl chatreset filereset gentoken signup testuser userpw: export DATABASE_PORT = $(or $(strip $(db_host_port)),$(error No running 'database' container for project '$(COMPOSE_PROJECT_NAME)'. Start its stack first with 'make dev'.))

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

# Images built for ENV=local — must match the `build` recipe's local set
# (api/gateway/setup-secrets are NOT built for local).
LOCAL_IMAGES := $(SETUP_DATABASE_REPO) $(DATABASE_REPO) $(OBJECT_STORE_REPO) \
	$(SUMMARY_REPO) $(HBPE_REPO)

# Identity of the source a Python sidecar image was built from, stamped onto
# the image as the `ci.source-tree` label by `build` and compared by `dev`.
#
# $(1) is the app directory under backend/apps. The three inputs are exactly
# what a sidecar image's content depends on: the service's own subtree, the
# ci-telemetry package both of them install, and the lock their `uv sync
# --frozen` resolves from. Git tree/blob hashes, so the stamp changes when one
# of those changes and never otherwise — a warm spin-up that touched neither
# sidecar still reuses its images.
#
# Read from HEAD, not the working tree: an uncommitted edit to a sidecar does
# NOT trigger a rebuild. That is the deliberate trade — hashing the working
# tree would mean re-hashing thousands of files on every `make dev`, and
# REBUILD=1 covers the uncommitted case.
sidecar_stamp = $(shell git rev-parse HEAD:backend/apps/$(1) HEAD:backend/packages/telemetry HEAD:uv.lock 2>/dev/null | tr '\n' '-')

VALID_ENVS := local staging production
VALID_GPUS := cpu cuda rocm

# GPU → HBPE Dockerfile (cpu uses the default Dockerfile)
HBPE_DOCKERFILE_cpu  := Dockerfile
HBPE_DOCKERFILE_cuda := Dockerfile.cuda
HBPE_DOCKERFILE_rocm := Dockerfile.rocm
HBPE_DOCKERFILE := $(HBPE_DOCKERFILE_$(GPU))

# The uv pin, read from required-version in the root pyproject.toml — the
# one authoritative place it is set. Passed to the Python Dockerfiles as
# UV_VERSION; setup-uv in CI reads the same field on its own.
UV_VERSION := $(shell sed -n 's/^required-version = "==\(.*\)"$$/\1/p' pyproject.toml)

# The llama-cpp-python pin: a commit on the JamePeng fork, which tracks
# llama.cpp HEAD and can load Qwen3.5 GGUFs (the official PyPI package is
# frozen at llama.cpp Aug 2025 and cannot). All three HBPE images build
# this same commit with hardware-specific CMake flags; the pin lives here
# because the install happens only in Dockerfiles, passed as a build arg.
# Bump deliberately: the fork moves fast and is our inference stack.
LLAMA_CPP_PYTHON_REF := 81190b03f6d177988112dad5fc919491a77705d1

# The version the fork reports AT that ref, which is not derivable from it —
# it comes from the fork's own metadata and is only known after a build. Its one
# job is to name the published wheel, so BUMP IT WITH THE REF ABOVE: get it from
# the filename build-llama-cpp-wheel.sh exports into dist-llama/. Wrong here and
# the default wheel tag points at nothing, which fails the pull loudly rather
# than installing anything incorrect.
LLAMA_CPP_PYTHON_VERSION := 0.3.46

# The AMD gfx architecture llama.cpp's HIP backend compiles for, detected from
# this host (gfx1100 on an RX 7900, gfx1030 on a 6800/6900). Empty is a valid
# answer and means "let llama.cpp pick its default target list"; pass
# AMDGPU_TARGETS=gfx#### explicitly to override, which is what a host with both
# an APU and a discrete card needs.
#
# Recursive (`?=` defines a deferred variable), so `rocminfo` is only invoked
# where the value is actually used — see HBPE_GPU_BUILD_ARGS below, which is
# the sole reference and is itself guarded on GPU=rocm. A cpu or cuda build
# therefore never shells out.
#
# `?=` also means an AMDGPU_TARGETS already in the environment wins, matching
# how ENV/GPU/REBUILD behave. Worth knowing that a ROCm workstation often
# exports one from a shell profile — which is precisely why the GPU guard lives
# at the point of use and not in this assignment. Attached here it would be
# defeated by that same ambient value, and a cpu build would still be handed a
# gfx target.
AMDGPU_TARGETS ?= $(shell scripts/detect-gpu.sh --amdgpu-arch)

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
AMDGPU_WHEEL_TARGETS ?= gfx1030;gfx1100;gfx1101;gfx1102;gfx1103;gfx1150;gfx1151;gfx1200;gfx1201

# The flash-attn pin. Installed outside the lock for the same reason
# llama-cpp-python is — it needs --no-build-isolation plus build-time
# environment variables, neither of which uv can express in a manifest — so it
# needs pinning here or not at all. It was the one unpinned dependency in the
# repo: `uv pip install flash-attn` resolved to whatever was newest that day,
# so two builds of the same commit could produce different images.
#
# CUDA only. flash-attn has no ROCm build, and the CPU image has no use for it.
FLASH_ATTN_VERSION := 2.8.3.post1

# Optional URL of a prebuilt flash-attn wheel, which skips a source compile of
# tens of minutes. It must match the image's torch version, CUDA major and
# C++11 ABI exactly; see the wheel notes in backend/apps/hbpe/Dockerfile.cuda
# for the naming scheme and how to read those values off the image. Unset by
# default because no wheel exists for every combination — there was none for
# torch 2.13 when this was written.
FLASH_ATTN_WHEEL ?=

# ── Prebuilt wheel images, and the tags that name them ────────────────────────
# Both expensive CUDA compiles come from FROM-scratch images on GHCR, published
# by backend/apps/hbpe/build-{flash-attn,llama-cpp}-wheel.sh and copied in by
# Dockerfile.cuda. Measured 2026-08-11 on a 24-core desktop: with both wheels a
# full `make build GPU=cuda` is 13.3 s, against ~71 min for the flash-attn
# source compile and 278 s for llama-cpp's.
#
# Images rather than URLs because they survive access control: both packages are
# public today and pull anonymously, but if either were made private, docker
# authenticates to the registry on its own, where a private URL would need a
# token passed as a build arg and baked into image history.
#
# THE TAGS ARE COMPOSED FROM THE PINS THEY DESCRIBE, not written out. A literal
# tag would survive a pin bump and quietly install the wheel built for the
# PREVIOUS pin — the build-time guards do not cover this: flash-attn's checks the
# ABI but not the version, and llama-cpp's checks the CUDA architectures but not
# the fork ref. Composed, a bump nobody has republished for produces a tag that
# does not exist, and the build fails at the pull with `manifest unknown`. That
# is the intended behaviour: a loud "republish the wheel" beats a silently wrong
# image. Republish with `PUSH=1 ./backend/apps/hbpe/build-<name>-wheel.sh`.
#
# Each component is read from the file that owns it. `:=` so the seds run once
# per make invocation rather than once per expansion.
HBPE_TORCH_VERSION := $(shell sed -n 's/^ *torch==\([0-9.]*\).*/\1/p' backend/apps/hbpe/Dockerfile.cuda | head -1)
HBPE_CUDA_MAJOR    := $(shell sed -n 's|^FROM nvidia/cuda:\([0-9]*\)\..*|\1|p' backend/apps/hbpe/Dockerfile.cuda | head -1)
HBPE_CUDA_ARCHS    := $(shell sed -n 's/^ARG TORCH_CUDA_ARCH_LIST="\(.*\)"$$/\1/p' backend/apps/hbpe/Dockerfile.cuda)
HBPE_PY_VERSION    := $(shell sed -n 's/^RUN uv python install \([0-9.]*\) *$$/\1/p' backend/apps/hbpe/Dockerfile.cuda | head -1)
HBPE_PY_TAG        := cp$(subst .,,$(HBPE_PY_VERSION))

# torch's local-version segment is MAJOR.MINOR — `basename` drops the patch,
# turning 2.13.0 into the 2.13 that setup.py stamps into the wheel name.
HBPE_TORCH_MINOR   := $(basename $(HBPE_TORCH_VERSION))
# 8.6;8.9;12.0 -> sm86_89_120. Underscores because dots would read as a version.
HBPE_ARCH_TAG      := sm$(subst ;,_,$(subst .,,$(HBPE_CUDA_ARCHS)))

# The C++11 ABI flag is the one component NOT derived: it is a property of how
# the torch wheel was compiled, readable only from an installed torch, and it
# HAS flipped between releases. If it ever flips again this tag keeps naming the
# old wheel, and the backstop is flash-attn's build-time import of
# flash_attn_2_cuda, which fails on an undefined symbol — loud, just later than
# a failed pull would be.
HBPE_TORCH_ABI     := cxx11abitrue

FLASH_ATTN_WHEEL_IMAGE ?= ghcr.io/companionintelligence/companion/flash-attn-wheel:$(FLASH_ATTN_VERSION)-cu$(HBPE_CUDA_MAJOR)torch$(HBPE_TORCH_MINOR)$(HBPE_TORCH_ABI)-$(HBPE_PY_TAG)
LLAMA_CPP_WHEEL_IMAGE  ?= ghcr.io/companionintelligence/companion/llama-cpp-wheel:$(LLAMA_CPP_PYTHON_VERSION)-$(shell echo $(LLAMA_CPP_PYTHON_REF) | cut -c1-12)-cu$(HBPE_CUDA_MAJOR)-$(HBPE_ARCH_TAG)-$(HBPE_PY_TAG)

# The ROCm equivalents, read from Dockerfile.rocm rather than Dockerfile.cuda.
# The python version is read separately even though both images pin 3.11 today:
# the cp tag is a claim about the image the wheel was built in, and borrowing
# the CUDA image's value would keep that claim looking right through exactly the
# divergence that would make it wrong.
HBPE_ROCM_VERSION    := $(shell sed -n 's|^FROM rocm/dev-ubuntu-22.04:\([0-9]*\.[0-9]*\).*|\1|p' backend/apps/hbpe/Dockerfile.rocm | head -1)
HBPE_ROCM_PY_VERSION := $(shell sed -n 's/^RUN uv python install \([0-9.]*\) *$$/\1/p' backend/apps/hbpe/Dockerfile.rocm | head -1)
HBPE_ROCM_PY_TAG     := cp$(subst .,,$(HBPE_ROCM_PY_VERSION))
# gfx1030;gfx1100;... -> gfx1030_1100_... The repeated "gfx" is dropped so the
# tag stays readable; build-llama-cpp-rocm-wheel.sh composes it identically.
HBPE_GFX_TAG         := gfx$(subst ;,_,$(subst gfx,,$(AMDGPU_WHEEL_TARGETS)))

LLAMA_CPP_ROCM_WHEEL_IMAGE ?= ghcr.io/companionintelligence/companion/llama-cpp-rocm-wheel:$(LLAMA_CPP_PYTHON_VERSION)-$(shell echo $(LLAMA_CPP_PYTHON_REF) | cut -c1-12)-rocm$(HBPE_ROCM_VERSION)-$(HBPE_GFX_TAG)-$(HBPE_ROCM_PY_TAG)

# Set any of them to empty to force the source compile:
#   make build GPU=cuda FLASH_ATTN_WHEEL_IMAGE= LLAMA_CPP_WHEEL_IMAGE=
#   make build GPU=rocm LLAMA_CPP_ROCM_WHEEL_IMAGE=
#
# A sed that stops matching would leave its component empty and compose a
# plausible-looking tag with a hole in it, so the components are checked rather
# than trusted. Guarded per variant: a restructured Dockerfile.cuda should not
# break a ROCm build, or the reverse.
ifeq ($(GPU),cuda)
$(if $(HBPE_TORCH_VERSION),,$(error could not read the torch pin from backend/apps/hbpe/Dockerfile.cuda))
$(if $(HBPE_CUDA_MAJOR),,$(error could not read the CUDA major from the FROM line in backend/apps/hbpe/Dockerfile.cuda))
$(if $(HBPE_CUDA_ARCHS),,$(error could not read ARG TORCH_CUDA_ARCH_LIST from backend/apps/hbpe/Dockerfile.cuda))
$(if $(HBPE_PY_VERSION),,$(error could not read the python version from backend/apps/hbpe/Dockerfile.cuda))
endif
ifeq ($(GPU),rocm)
$(if $(HBPE_ROCM_VERSION),,$(error could not read the ROCm version from the FROM line in backend/apps/hbpe/Dockerfile.rocm))
$(if $(HBPE_ROCM_PY_VERSION),,$(error could not read the python version from backend/apps/hbpe/Dockerfile.rocm))
$(if $(AMDGPU_WHEEL_TARGETS),,$(error AMDGPU_WHEEL_TARGETS is empty — a published wheel needs an explicit gfx target list))
endif

# Passed per hardware variant: each Dockerfile declares only the ARGs it uses,
# and docker warns on a build-arg nothing consumes.
HBPE_GPU_BUILD_ARGS = \
	$(if $(filter rocm,$(GPU)),--build-arg AMDGPU_TARGETS=$(AMDGPU_TARGETS) \
		$(if $(LLAMA_CPP_ROCM_WHEEL_IMAGE),--build-arg LLAMA_CPP_ROCM_WHEEL_IMAGE=$(LLAMA_CPP_ROCM_WHEEL_IMAGE))) \
	$(if $(filter cuda,$(GPU)),--build-arg FLASH_ATTN_VERSION=$(FLASH_ATTN_VERSION) \
		$(if $(FLASH_ATTN_WHEEL),--build-arg FLASH_ATTN_WHEEL=$(FLASH_ATTN_WHEEL)) \
		$(if $(FLASH_ATTN_WHEEL_IMAGE),--build-arg FLASH_ATTN_WHEEL_IMAGE=$(FLASH_ATTN_WHEEL_IMAGE)) \
		$(if $(LLAMA_CPP_WHEEL_IMAGE),--build-arg LLAMA_CPP_WHEEL_IMAGE=$(LLAMA_CPP_WHEEL_IMAGE)))


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

	@VOLS=$$(docker volume ls -q --filter "name=$(PROJECT_NAME)"); \
	if [ -n "$$VOLS" ]; then \
		printf "\n➤ Removing project volumes...\n"; \
		printf "$$VOLS\n"; \
		echo "$$VOLS" | xargs docker volume rm -f >/dev/null 2>&1 || true; \
	fi

	@NETS=$$(docker network ls -q --filter "name=$(PROJECT_NAME)"); \
	if [ -n "$$NETS" ]; then \
		printf "\n➤ Removing project networks...\n"; \
		printf "$$NETS\n"; \
		echo "$$NETS" | xargs docker network rm -f >/dev/null 2>&1 || true; \
	fi

	@printf "\n$(GREEN)✓$(RESET) Reset complete.\n\n"

.PHONY: build
build: ## Build images. ENV=local|staging|production (default local) GPU=cpu|cuda|rocm (default: auto-detected)
	@echo "$(VALID_ENVS)" | grep -qw "$(ENV)" || { printf "$(RED)✗$(RESET) Invalid ENV '$(ENV)'. Choose one of: $(VALID_ENVS)\n\n"; exit 1; }
	@echo "$(VALID_GPUS)" | grep -qw "$(GPU)" || { printf "$(RED)✗$(RESET) Invalid GPU '$(GPU)'. Choose one of: $(VALID_GPUS)\n\n"; exit 1; }

	@test -n "$(UV_VERSION)" || { printf "$(RED)✗$(RESET) Could not read the uv pin from required-version in pyproject.toml.\n\n"; exit 1; }

	@# The Python images sync with --frozen, which trusts uv.lock as-is so
	@# each Dockerfile only has to copy the manifests it actually uses. The
	@# freshness check they gave up lives here instead, where the whole
	@# workspace is present: fail before building anything rather than bake
	@# a stale resolution into an image.
	@uv lock --check || { printf "$(RED)✗$(RESET) uv.lock is out of date with the manifests. Run 'uv lock' and retry.\n\n"; exit 1; }

	@$(MAKE) distribute-license

	@printf "$(call task_icon,build,🧱) Building $(ENV) images...\n"

	@# API, gateway and web frontend are only built for staging/production
	@#
	@# The API is no longer compiled here: backend/apps/api/Dockerfile is a
	@# multi-stage build that compiles from source in its own builder stage, so
	@# the image no longer depends on a dist/ produced by whatever toolchain the
	@# host happens to have. The web frontend IS still host-built, because
	@# infrastructure/gateway/Dockerfile copies frontend/apps/web/dist.
	@if [ "$(ENV)" != "local" ]; then printf "\n➤ Compiling web frontend...\n\n" && ( cd frontend/apps/web && yarn clean && yarn build ) && printf "\n➤ Building API image...\n\n" && docker build -f backend/apps/api/Dockerfile $(call versioned_tag,$(API_REPO)) -t $(API_REPO):latest . && printf "\n➤ Building gateway image...\n\n" && docker build -f infrastructure/gateway/Dockerfile $(call versioned_tag,$(GATEWAY_REPO)) -t $(GATEWAY_REPO):latest . ; fi

	@printf "\n➤ Building database setup image...\n\n"
	@docker build -f infrastructure/setup-database/Dockerfile $(call versioned_tag,$(SETUP_DATABASE_REPO)) -t $(SETUP_DATABASE_REPO):latest infrastructure/setup-database

	@printf "\n➤ Building database image...\n\n"
	@docker build -f infrastructure/database/Dockerfile $(call versioned_tag,$(DATABASE_REPO)) -t $(DATABASE_REPO):latest infrastructure/database

	@printf "\n➤ Building object store image...\n\n"
	@docker build -f infrastructure/object-store/Dockerfile $(call versioned_tag,$(OBJECT_STORE_REPO)) -t $(OBJECT_STORE_REPO):latest infrastructure/object-store

	@# setup-secrets is only built for production
	@if [ "$(ENV)" = "production" ]; then printf "\n➤ Building setup secrets image...\n\n" && docker build -f infrastructure/setup-secrets/Dockerfile $(call versioned_tag,$(SETUP_SECRETS_REPO)) -t $(SETUP_SECRETS_REPO):latest infrastructure/setup-secrets ; fi

	@printf "\n➤ Building summary service image...\n\n"
	@# --label ci.source-tree: what `dev` reads to decide the image on disk is
	@# still the code under review. See sidecar_stamp above.
	@docker build -f backend/apps/summary/Dockerfile --build-arg UV_VERSION=$(UV_VERSION) --label ci.source-tree=$(call sidecar_stamp,summary) $(call versioned_tag,$(SUMMARY_REPO)) -t $(SUMMARY_REPO):latest .

	@printf "\n➤ Building HBPE service image ($(GPU)$(if $(filter rocm,$(GPU)),$(if $(AMDGPU_TARGETS), $(AMDGPU_TARGETS), no-gfx-target)))...\n\n"
ifeq ($(GPU),rocm)
	@test -n "$(AMDGPU_TARGETS)" || { \
		printf "$(YELLOW)•$(RESET) No AMD gfx architecture detected — llama.cpp will build for its default\n"; \
		printf "  target list, which may not include this host's card. Pass $(YELLOW)AMDGPU_TARGETS=gfx####$(RESET)\n"; \
		printf "  to compile for it explicitly ($(YELLOW)rocminfo | grep gfx$(RESET) reports it).\n\n"; \
	}
endif
	@docker build -f backend/apps/hbpe/$(HBPE_DOCKERFILE) --build-arg UV_VERSION=$(UV_VERSION) --build-arg LLAMA_CPP_PYTHON_REF=$(LLAMA_CPP_PYTHON_REF) $(HBPE_GPU_BUILD_ARGS) --label ci.source-tree=$(call sidecar_stamp,hbpe) $(call versioned_tag,$(HBPE_REPO)) -t $(HBPE_REPO):latest .

	@$(MAKE) clean-license

	@printf "\n"

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
	@printf "$(call task_icon,dev,🧑‍💻) Starting development environment...\n\n"

	@$(MAKE) health

	@OVERMIND=$$(which overmind 2>/dev/null); \
	if [ -z "$$OVERMIND" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'overmind' installed or it is not in your PATH.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) overmind found at $$OVERMIND\n\n"; \
	fi

	@CADDY=$$(which caddy 2>/dev/null); \
	if [ -z "$$CADDY" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'caddy' installed or it is not in your PATH.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) caddy found at $$CADDY\n\n"; \
	fi

	@if curl -sf http://localhost:2019/config/ >/dev/null 2>&1; then \
		printf "  $(GREEN)✓$(RESET) caddy admin API reachable on :2019\n\n"; \
	else \
		printf "  $(RED)✗$(RESET) caddy admin API not reachable on :2019. Start it with 'brew services start caddy'.\n\n"; \
		exit 1; \
	fi

	@OLLAMA=$$(which ollama 2>/dev/null); \
	if [ -z "$$OLLAMA" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'ollama' installed or it is not in your PATH.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) ollama found at $$OLLAMA 🦙\n\n"; \
	fi

	@if nc -z localhost 11434 > /dev/null 2>&1; then \
		printf "  $(GREEN)✓$(RESET) ollama is running on port 11434\n\n"; \
	else \
		printf "  $(RED)✗$(RESET) ollama is NOT running on port 11434. Please start ollama (e.g., 'ollama serve')\n\n"; \
		exit 1; \
	fi

	@# ...and reachable the way the CONTAINERS reach it, which is not the same
	@# question. The check above proves ollama answers on loopback; the sidecars
	@# resolve it through `host.docker.internal` (docker-compose gives them
	@# `extra_hosts: host-gateway`), and ollama binds 127.0.0.1 by DEFAULT. So a
	@# box where ollama is plainly running still hands the summary service an
	@# unreachable LLM_API_BASE.
	@#
	@# That failure is not quiet in a useful way. `.env.default` deliberately
	@# leaves LLM_DEFAULT_CHAT_MODEL unset — CI Hub injects it on a real
	@# appliance, and the sidecar otherwise DISCOVERS a model from
	@# LLM_API_BASE/models — so when discovery times out the summary service
	@# raises at import and the container crash-loops. Before it had a compose
	@# healthcheck it sat there reporting `Up`.
	@#
	@# The probe is the container's own question, asked from the host: connect to
	@# the docker bridge GATEWAY, which is what `host.docker.internal` resolves
	@# to. Testing for "any non-loopback listener" is not good enough — this box
	@# also binds a tailnet address, which looks reachable and is not.
	@#
	@# A warning, not a hard failure: OLLAMA_HOST may legitimately point at
	@# another machine, and a host with no docker bridge skips the check.
	@GW=$$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null); \
	if [ -n "$$GW" ]; then \
		if nc -z -w 2 "$$GW" 11434 > /dev/null 2>&1; then \
			printf "  $(GREEN)✓$(RESET) ollama is reachable from containers (via $$GW)\n\n"; \
		else \
			printf "  $(YELLOW)•$(RESET) ollama is listening on loopback only, so containers cannot reach it\n"; \
			printf "    through host.docker.internal and the summary service will crash-loop on model\n"; \
			printf "    discovery. Restart it bound to all interfaces:  $(YELLOW)OLLAMA_HOST=0.0.0.0 ollama serve$(RESET)\n"; \
			printf "    (or pin $(YELLOW)LLM_DEFAULT_CHAT_MODEL$(RESET) in .env to skip discovery entirely).\n\n"; \
		fi; \
	fi

	@# Every required model, pulled if absent. `ollama pull` streams its own
	@# progress and blocks until the blobs are on disk, so boot simply waits here
	@# on a cold machine instead of failing and leaving the operator to run the
	@# pull by hand. A tag-less name lands as `<name>:latest`, which is what the
	@# presence test accepts alongside the literal name; matching on the tag
	@# column (not the whole line) keeps `nomic-embed-text` from being satisfied
	@# by an unrelated `nomic-embed-text-v2-moe`.
	@for MODEL in $(REQUIRED_OLLAMA_MODELS); do \
		if ollama list | awk 'NR>1 {print $$1}' | grep -qxF -e "$$MODEL" -e "$$MODEL:latest"; then \
			printf "  $(GREEN)✓$(RESET) ollama model '$$MODEL' is available\n\n"; \
		else \
			printf "  $(YELLOW)•$(RESET) ollama model '$$MODEL' is not pulled yet — downloading now (this can take several minutes)...\n\n"; \
			if ollama pull "$$MODEL"; then \
				printf "\n  $(GREEN)✓$(RESET) ollama model '$$MODEL' pulled\n\n"; \
			else \
				printf "\n  $(RED)✗$(RESET) Failed to pull ollama model '$$MODEL'. Fix the error above (or run $(YELLOW)ollama pull $$MODEL$(RESET) manually) and retry.\n\n"; \
				exit 1; \
			fi; \
		fi; \
	done

	@$(MAKE) init

	@# The supervisor runs `docker compose up` (not build), so the local images
	@# must exist first. Build them only when one is missing, a Python sidecar
	@# image was built from source other than this commit's, or REBUILD=1 — a warm
	@# spin-up reuses them.
	@#
	@# The staleness half exists because "present" used to be the whole test: an
	@# hbpe-service image a month older than the routes the API calls satisfied
	@# it, so every worktree on the box ran a sidecar that was not the code under
	@# review, and no amount of manual QA could have noticed.
	@missing=""; for img in $(LOCAL_IMAGES); do \
		docker image inspect "$$img:latest" >/dev/null 2>&1 || missing="$$missing $$img"; \
	done; \
	stale=""; \
	for pair in "$(SUMMARY_REPO):$(call sidecar_stamp,summary)" "$(HBPE_REPO):$(call sidecar_stamp,hbpe)"; do \
		img="$${pair%%:*}"; want="$${pair#*:}"; \
		case " $$missing " in *" $$img "*) continue ;; esac; \
		[ -n "$$want" ] || continue; \
		have=$$(docker image inspect --format '{{index .Config.Labels "ci.source-tree"}}' "$$img:latest" 2>/dev/null); \
		[ "$$have" = "$$want" ] || stale="$$stale $$img"; \
	done; \
	if [ -n "$(REBUILD)" ] || [ -n "$$missing" ] || [ -n "$$stale" ]; then \
		[ -n "$$missing" ] && printf "$(YELLOW)•$(RESET) building — missing image(s):$$missing\n\n" || true; \
		[ -n "$$stale" ] && printf "$(YELLOW)•$(RESET) building — sidecar image(s) built from other source:$$stale\n\n" || true; \
		$(MAKE) build ENV=local GPU=$(GPU); \
	else \
		printf "$(GREEN)✓$(RESET) Reusing existing local images (set $(YELLOW)REBUILD=1$(RESET) to rebuild)\n\n"; \
	fi

	@# Hand off to the per-worktree stack supervisor: it allocates ports, brings
	@# up the compose stack, migrates, registers the Caddy route at
	@# $(PROJECT_NAME).localhost, and runs the Procfile via overmind. Foreground;
	@# Ctrl-C tears the route down and stops the stack.
	@yarn tsx scripts/dev-stack/index.ts up --key $(PROJECT_NAME)

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
		elif [ -f "$$main_hooks/pre-commit" ] && git config --worktree core.hooksPath "$$main_hooks" 2>/dev/null; then \
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
	@yarn dlx @yarnpkg/sdks vscode

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

	@if [ ! -f .env ]; then \
		printf "Copying dotenv template file... "; \
		cp -v .env.default .env; \
		printf "\n"; \
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
	@printf "$(call task_icon,test,🧪) Running tests...\n\n"

	@# foreach only runs workspaces that declare a test script, so a new
	@# workspace's tests are picked up without a line here.
	@yarn workspaces foreach --all run test

	@printf "\n"

	@# Named explicitly because `foreach` cannot reach it: frontend/apps/desktop
	@# is deliberately EXCLUDED from the Yarn workspaces (root package.json —
	@# Tauri walks a real node_modules tree that PnP does not produce), so it is
	@# invisible both to the line above and to the untested-workspace warning at
	@# the end of this target. Without this line the suite that covers which
	@# server images a shipped desktop app pulls would run in CI
	@# (`desktop-guards` in pr-gate.yml) and nowhere a developer can see before
	@# pushing. Dependency-free — node's own runner, no install, ~60ms.
	@#
	@# The file list is discovered and asserted non-empty rather than passed as
	@# a glob, matching the CI lane: `node --test 'path/*.test.cjs'` with zero
	@# matches exits 0 reporting `# pass 0`, so the obvious form would go green
	@# having run nothing the moment the suite is renamed. The bare directory
	@# form is worse still — it does not recurse on this repo's pinned Node and
	@# reports a bogus MODULE_NOT_FOUND failure instead.
	@suites=$$(find frontend/apps/desktop/scripts -name '*.test.cjs' -not -path '*/node_modules/*' | sort); \
	if [ -z "$$suites" ]; then \
		printf "$(RED)✗$(RESET) Found no *.test.cjs under frontend/apps/desktop/scripts — this step would have checked nothing.\n\n"; \
		exit 1; \
	fi; \
	node --test $$suites

	@printf "\n"

	@uv run pytest

	@printf "\nAll the tests that exist passed.\n\n"

	@# "All tests passed" used to be a lie of omission, and this block is the
	@# correction: `foreach` SILENTLY SKIPS a workspace that declares no `test`
	@# script — no line of output, no warning, no non-zero exit. All eight
	@# frontend/packages/* are in exactly that state, so the line above was
	@# reporting on two workspaces while sounding like it reported on all
	@# eleven. `typecheck` above already learned this lesson from the same
	@# `foreach` behaviour; this target learns the reporting half of it.
	@#
	@# It does NOT fail the build: a package may legitimately have nothing
	@# worth testing yet, and the root workspace's only suites are the
	@# Playwright e2e configs that `make test` deliberately does not run. It
	@# just refuses to let silence read as coverage — naming them is what makes
	@# a package that quietly lost its tests visible in the place it went quiet.
	@#
	@# node, not jq: `make health` already guarantees node; jq is not a
	@# prerequisite of this repo. The `sed` pulls the location out of yarn's
	@# JSON-lines output (one object per line, no nesting).
	@untested=$$(yarn workspaces list --json \
		| sed -n 's/.*"location":"\([^"]*\)".*/\1/p' \
		| while read -r loc; do \
			node -e 'const fs=require("node:fs"),p=require("node:path").join(process.argv[1],"package.json");const j=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};process.exit(j.scripts&&j.scripts.test?0:1)' "$$loc" \
				|| printf "%s\n" "$$loc"; \
		done); \
	if [ -n "$$untested" ]; then \
		printf "$(YELLOW)⚠$(RESET)  %s workspace(s) declare no 'test' script and were skipped, silently, by 'yarn workspaces foreach':\n" "$$(printf "%s\n" "$$untested" | wc -l | tr -d ' ')"; \
		printf "%s\n" "$$untested" \
			| sed -e 's|^\.$$|. (repo root — its only suites are the Playwright e2e configs)|' -e 's/^/       /'; \
		printf "\n"; \
	fi

	@# The native suites are deliberately not part of this target (see the
	@# comment above `test-android`), so say where they are rather than let
	@# "All the tests that exist passed" imply more than it means.
	@printf "$(BLUE)ⓘ$(RESET)  Native suites are separate: $(YELLOW)make test-android$(RESET), $(YELLOW)make test-desktop$(RESET)\n\n"

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
# database here — check:migrations only reads migration filenames, and dbmate's
# --help resolves bin/dbmate.js's imports without connecting. entrypoint.sh is
# bypassed because it demands the eight runtime secrets. A missing image is an
# error, not a pass: a gate that verified nothing must not report green.
	@docker image inspect $(API_REPO):latest >/dev/null 2>&1 || { \
		printf "  ✗ $(API_REPO):latest not found — run 'make build' first.\n\n"; \
		exit 1; \
	}

	@docker run --rm --entrypoint sh $(API_REPO):latest -c \
		'yarn check:migrations && node bin/dbmate.js --help >/dev/null'

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
	worker_state=$$(docker inspect -f '{{.State.Running}} {{.State.RestartCount}}' "$$worker_cid"); \
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
publish: init ## Publish CI-Server images and metadata to the CI-Portal store
	@$(MAKE) build ENV=production GPU=$(GPU)

	@$(MAKE) smoke-api

	@# smoke-api only proves the image's imports resolve. This one boots the
	@# stack it is about to publish and requires a real 200 from the gateway on
	@# BOTH /api/health and the SPA shell, plus a worker that survives its own
	@# DI graph — so a DI fault, a broken entrypoint, a bad nginx.conf or a
	@# gateway image with an empty web root stops the release here rather than
	@# at a user's first launch.
	@$(MAKE) smoke-stack

	@printf "$(call task_icon,publish,📦) Publishing to CI-Portal registry...\n\n"

	@scripts/publish/publish.sh

	@printf "\n"

.PHONY: publish-quiet
publish-quiet: ## Publish to CI-Portal store (quiet mode)
	@scripts/publish/publish.sh -q

.PHONY: seed
seed: ## Seed database with John Smith user and demo data
	@printf "$(call task_icon,seed,🌱) Seeding database...\n\n"

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
