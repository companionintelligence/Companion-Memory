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
export ORCHESTRATOR_REPO ?= ci/orchestrator
export SETUP_SECRETS_REPO ?= ci/setup-secrets
export SETUP_DATABASE_REPO ?= ci/setup-database
export SETUP_ORCHESTRATOR_REPO ?= ci/setup-orchestrator
export SUMMARY_REPO ?= ci/summary-service
export HBPE_REPO ?= ci/hbpe-service

# Seed user UUID (John Smith) — must match backend/apps/api/scripts/seed-database/data/users.ts
JOHN_SMITH_USER_ID := b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b

export TAG ?= $(shell git describe --tags --exact-match 2>/dev/null)


# Subdirectory build contexts that need a copy of LICENSE
LICENSE_DIRS := \
	infrastructure/database \
	infrastructure/object-store \
	infrastructure/orchestrator \
	infrastructure/setup-database \
	infrastructure/setup-orchestrator \
	infrastructure/setup-secrets \
	backend/apps/summary \
	backend/apps/hbpe

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
# Empty means no `database` container is running for this project. The primary
# checkout may then assume the conventional 5432; a worktree must not. Silently
# falling back to 5432 would point seed/migrate/dbclear at the primary stack's
# database. So a worktree with no running stack errors out (see below).
db_host_port = $(shell \
	port=$$(docker ps \
		--filter "label=com.docker.compose.project=$(COMPOSE_PROJECT_NAME)" \
		--filter "label=com.docker.compose.service=database" \
		--format '{{.Ports}}' 2>/dev/null \
		| sed -n 's/.*:\([0-9]*\)->5432\/tcp.*/\1/p' | head -n1); \
	if [ -n "$$port" ]; then echo "$$port"; \
	elif [ "$(PROJECT_NAME)" = "$(REPO)" ]; then echo 5432; fi)

# Point every local-DB target at that port. node-config reads DATABASE_PORT, and
# dotenv won't override an already-set env var, so this wins over .env's 5432.
# Evaluated lazily per target, so non-DB targets never pay the Docker lookup.
seed migrate dbclear dbdestroy dbshell dburl chatreset filereset gentoken signup userpw: export DATABASE_PORT = $(or $(strip $(db_host_port)),$(error No running 'database' container for project '$(COMPOSE_PROJECT_NAME)'. Start its stack first with 'make dev'.))

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
# GPU selects the HBPE base image (cpu = the default Dockerfile).
# ─────────────────────────────────────────────────────────────────────
ENV ?= local
GPU ?= cpu
# REBUILD=1 forces `dev`/`local` to rebuild local images; unset reuses them.
REBUILD ?=

# Images built for ENV=local — must match the `build` recipe's local set
# (api/gateway/setup-secrets are NOT built for local).
LOCAL_IMAGES := $(SETUP_DATABASE_REPO) $(DATABASE_REPO) $(OBJECT_STORE_REPO) \
	$(SETUP_ORCHESTRATOR_REPO) $(ORCHESTRATOR_REPO) $(SUMMARY_REPO) $(HBPE_REPO)

VALID_ENVS := local staging production
VALID_GPUS := cpu cuda rocm

# GPU → HBPE Dockerfile (cpu uses the default Dockerfile)
HBPE_DOCKERFILE_cpu  := Dockerfile
HBPE_DOCKERFILE_cuda := Dockerfile.cuda
HBPE_DOCKERFILE_rocm := Dockerfile.rocm
HBPE_DOCKERFILE := $(HBPE_DOCKERFILE_$(GPU))


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
build: ## Build images. ENV=local|staging|production (default local) GPU=cpu|cuda|rocm (default cpu)
	@echo "$(VALID_ENVS)" | grep -qw "$(ENV)" || { printf "$(RED)✗$(RESET) Invalid ENV '$(ENV)'. Choose one of: $(VALID_ENVS)\n\n"; exit 1; }
	@echo "$(VALID_GPUS)" | grep -qw "$(GPU)" || { printf "$(RED)✗$(RESET) Invalid GPU '$(GPU)'. Choose one of: $(VALID_GPUS)\n\n"; exit 1; }

	@$(MAKE) distribute-license

	@printf "$(call task_icon,build,🧱) Building $(ENV) images...\n"

	@# API, gateway and web frontend are only built for staging/production
	@if [ "$(ENV)" != "local" ]; then printf "\n➤ Compiling API...\n\n" && ( cd backend/apps/api && yarn clean && yarn build ) && printf "\n➤ Compiling web frontend...\n\n" && ( cd frontend/apps/web && yarn clean && yarn build ) && printf "\n➤ Building API image...\n\n" && docker build -f backend/apps/api/Dockerfile $(call versioned_tag,$(API_REPO)) -t $(API_REPO):latest . && printf "\n➤ Building gateway image...\n\n" && docker build -f infrastructure/gateway/Dockerfile $(call versioned_tag,$(GATEWAY_REPO)) -t $(GATEWAY_REPO):latest . ; fi

	@printf "\n➤ Building database setup image...\n\n"
	@docker build -f infrastructure/setup-database/Dockerfile $(call versioned_tag,$(SETUP_DATABASE_REPO)) -t $(SETUP_DATABASE_REPO):latest infrastructure/setup-database

	@printf "\n➤ Building database image...\n\n"
	@docker build -f infrastructure/database/Dockerfile $(call versioned_tag,$(DATABASE_REPO)) -t $(DATABASE_REPO):latest infrastructure/database

	@printf "\n➤ Building object store image...\n\n"
	@docker build -f infrastructure/object-store/Dockerfile $(call versioned_tag,$(OBJECT_STORE_REPO)) -t $(OBJECT_STORE_REPO):latest infrastructure/object-store

	@printf "\n➤ Building orchestrator setup image...\n\n"
	@docker build -f infrastructure/setup-orchestrator/Dockerfile $(call versioned_tag,$(SETUP_ORCHESTRATOR_REPO)) -t $(SETUP_ORCHESTRATOR_REPO):latest infrastructure/setup-orchestrator

	@printf "\n➤ Building orchestrator image...\n\n"
	@docker build -f infrastructure/orchestrator/Dockerfile $(call versioned_tag,$(ORCHESTRATOR_REPO)) -t $(ORCHESTRATOR_REPO):latest infrastructure/orchestrator

	@# setup-secrets is only built for production
	@if [ "$(ENV)" = "production" ]; then printf "\n➤ Building setup secrets image...\n\n" && docker build -f infrastructure/setup-secrets/Dockerfile $(call versioned_tag,$(SETUP_SECRETS_REPO)) -t $(SETUP_SECRETS_REPO):latest infrastructure/setup-secrets ; fi

	@printf "\n➤ Building summary service image...\n\n"
	@docker build -f backend/apps/summary/Dockerfile $(call versioned_tag,$(SUMMARY_REPO)) -t $(SUMMARY_REPO):latest backend/apps/summary

	@printf "\n➤ Building HBPE service image ($(GPU))...\n\n"
	@docker build -f backend/apps/hbpe/$(HBPE_DOCKERFILE) $(call versioned_tag,$(HBPE_REPO)) -t $(HBPE_REPO):latest backend/apps/hbpe

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

	@MODEL=nomic-embed-text; \
	ollama list | grep -Fq "$$MODEL"; \
	STATUS=$$?; \
	if [ "$$STATUS" -eq 0 ]; then \
		printf "  $(GREEN)✓$(RESET) ollama model '$$MODEL' is available\n\n"; \
	else \
		printf "  $(RED)✗$(RESET) ollama model '$$MODEL' is not yet pulled\n\n"; \
		exit 1; \
	fi

	@MODEL=gemma3:1b; \
	ollama list | grep -Fq "$$MODEL"; \
	STATUS=$$?; \
	if [ "$$STATUS" -eq 0 ]; then \
		printf "  $(GREEN)✓$(RESET) ollama model '$$MODEL' is available\n\n"; \
	else \
		printf "  $(RED)✗$(RESET) ollama model '$$MODEL' is not yet pulled\n\n"; \
		exit 1; \
	fi

	@$(MAKE) init

	@# The supervisor runs `docker compose up` (not build), so the local images
	@# must exist first. Build them only when one is missing or REBUILD=1 — a warm
	@# spin-up reuses them.
	@missing=""; for img in $(LOCAL_IMAGES); do \
		docker image inspect "$$img:latest" >/dev/null 2>&1 || missing="$$missing $$img"; \
	done; \
	if [ -n "$(REBUILD)" ] || [ -n "$$missing" ]; then \
		[ -n "$$missing" ] && printf "$(YELLOW)•$(RESET) building — missing image(s):$$missing\n\n" || true; \
		$(MAKE) build ENV=local GPU=$(GPU); \
	else \
		printf "$(GREEN)✓$(RESET) Reusing existing local images (set $(YELLOW)REBUILD=1$(RESET) to rebuild)\n\n"; \
	fi

	@# Hand off to the per-worktree stack supervisor: it allocates ports, brings
	@# up the compose stack, migrates, registers the Caddy route at
	@# $(PROJECT_NAME).localhost, and runs the Procfile via overmind. Foreground;
	@# Ctrl-C tears the route down and stops the stack.
	@yarn tsx scripts/dev-stack/index.ts up --key $(PROJECT_NAME)

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
	@yarn install

	@printf "\n"
	@yarn dlx @yarnpkg/sdks vscode

	@printf "\n"
	@yarn prepare

	@if [ ! -f .env ]; then \
		printf "Copying dotenv template file... "; \
		cp -v .env.default .env; \
		printf "\n"; \
	fi

.PHONY: install
install: ## Install project dependencies
	@printf "$(call task_icon,install,📦) Installing dependencies...\n\n"

	@yarn install

	@printf "\n"

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

.PHONY: publish
publish: init ## Publish CI-Server images and metadata to the CI-Portal store
	@$(MAKE) build ENV=production GPU=$(GPU)

	@$(MAKE) smoke-api

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
