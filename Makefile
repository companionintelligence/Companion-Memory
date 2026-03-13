.DEFAULT_GOAL := help

RED=\033[0;31m
GREEN=\033[0;32m
YELLOW=\033[0;33m
RESET=\033[0m

export API_REPO ?= ci/api
export DATABASE_REPO ?= ci/database
export GATEWAY_REPO ?= ci/gateway
export OBJECT_STORE_REPO ?= ci/object-store
export ORCHESTRATOR_REPO ?= ci/orchestrator
export SETUP_SECRETS_REPO ?= ci/setup-secrets
export SETUP_DATABASE_REPO ?= ci/setup-database
export SETUP_ORCHESTRATOR_REPO ?= ci/setup-orchestrator
export STT_REPO ?= ci/stt-service
export SUMMARY_REPO ?= ci/summary-service
export TTS_REPO ?= ci/tts-service

export TAG ?= $(shell git describe --tags --exact-match 2>/dev/null)

# Helper: expands to "-t repo:tag" only when TAG is non-empty
versioned_tag = $(if $(TAG),-t $(1):$(TAG))

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

.PHONY: reset
reset: ## Reset the local development environment
	@printf "🧹 Resetting Docker environment INCLUDING ALL DATA...\n\n"

	@$(MAKE) stop

	@if tmux has-session -t companion 2>/dev/null; then \
		printf "\n➤ Killing tmux dev session...\n\n"; \
		tmux kill-session -t companion; \
	fi

	@printf "\n➤ Removing project volumes...\n\n"
	@docker volume ls -q --filter "name=ci-server_" | xargs -r docker volume rm -f 2>/dev/null || true

	@printf "\n➤ Removing project images...\n\n"
	@docker images --format '{{.Repository}}:{{.Tag}}' | grep '^ci/' | xargs -r docker rmi -f 2>/dev/null || true

	@printf "\n➤ Pruning unused networks...\n\n"
	@docker network prune --force 2>/dev/null || true

	@printf "\n$(GREEN)✓$(RESET) Reset complete.\n\n"

.PHONY: build-local
build-local: ## Build Docker images for local development
	@printf "🧱 Building local images...\n\n"

	@printf "➤ Building database setup image...\n\n"
	@docker build -f infrastructure/setup-database/Dockerfile $(call versioned_tag,$(SETUP_DATABASE_REPO)) -t $(SETUP_DATABASE_REPO):latest infrastructure/setup-database

	@printf "\n➤ Building database image...\n\n"
	@docker build -f infrastructure/database/Dockerfile $(call versioned_tag,$(DATABASE_REPO)) -t $(DATABASE_REPO):latest infrastructure/database

	@printf "\n➤ Building object store image...\n\n"
	@docker build -f infrastructure/object-store/Dockerfile $(call versioned_tag,$(OBJECT_STORE_REPO)) -t $(OBJECT_STORE_REPO):latest infrastructure/object-store

	@printf "\n➤ Building orchestrator setup image...\n\n"
	@docker build -f infrastructure/setup-orchestrator/Dockerfile $(call versioned_tag,$(SETUP_ORCHESTRATOR_REPO)) -t $(SETUP_ORCHESTRATOR_REPO):latest infrastructure/setup-orchestrator

	@printf "\n➤ Building orchestrator image...\n\n"
	@docker build -f infrastructure/orchestrator/Dockerfile $(call versioned_tag,$(ORCHESTRATOR_REPO)) -t $(ORCHESTRATOR_REPO):latest infrastructure/orchestrator

	@printf "\n➤ Building speech-to-text service image...\n\n"
	@docker build -f backend/apps/stt/Dockerfile $(call versioned_tag,$(STT_REPO)) -t $(STT_REPO):latest backend/apps/stt

	@printf "\n➤ Building summary service image...\n\n"
	@docker build -f backend/apps/summary/Dockerfile $(call versioned_tag,$(SUMMARY_REPO)) -t $(SUMMARY_REPO):latest backend/apps/summary

	@printf "\n➤ Building text-to-speech service image...\n\n"
	@docker build -f backend/apps/tts/Dockerfile $(call versioned_tag,$(TTS_REPO)) -t $(TTS_REPO):latest backend/apps/tts

	@printf "\n"

.PHONY: build-staging
build-staging: ## Build Docker images for staging deployment
	@printf "🧱 Building staging images...\n\n"

	@printf "➤ Compiling API...\n\n"
	@cd backend/apps/api && yarn clean && yarn build

	@printf "\n➤ Compiling web frontend...\n\n"
	@cd frontend/apps/web && yarn clean && yarn build

	@printf "\n➤ Building API image...\n\n"
	@docker build -f backend/apps/api/Dockerfile $(call versioned_tag,$(API_REPO)) -t $(API_REPO):latest .

	@printf "\n➤ Building database setup image...\n\n"
	@docker build -f infrastructure/setup-database/Dockerfile $(call versioned_tag,$(SETUP_DATABASE_REPO)) -t $(SETUP_DATABASE_REPO):latest infrastructure/setup-database

	@printf "\n➤ Building database image...\n\n"
	@docker build -f infrastructure/database/Dockerfile $(call versioned_tag,$(DATABASE_REPO)) -t $(DATABASE_REPO):latest infrastructure/database

	@printf "\n➤ Building gateway image...\n\n"
	@docker build -f infrastructure/gateway/Dockerfile $(call versioned_tag,$(GATEWAY_REPO)) -t $(GATEWAY_REPO):latest .

	@printf "\n➤ Building object store image...\n\n"
	@docker build -f infrastructure/object-store/Dockerfile $(call versioned_tag,$(OBJECT_STORE_REPO)) -t $(OBJECT_STORE_REPO):latest infrastructure/object-store

	@printf "\n➤ Building orchestrator setup image...\n\n"
	@docker build -f infrastructure/setup-orchestrator/Dockerfile $(call versioned_tag,$(SETUP_ORCHESTRATOR_REPO)) -t $(SETUP_ORCHESTRATOR_REPO):latest infrastructure/setup-orchestrator

	@printf "\n➤ Building orchestrator image...\n\n"
	@docker build -f infrastructure/orchestrator/Dockerfile $(call versioned_tag,$(ORCHESTRATOR_REPO)) -t $(ORCHESTRATOR_REPO):latest infrastructure/orchestrator

	@printf "\n➤ Building speech-to-text service image...\n\n"
	@docker build -f backend/apps/stt/Dockerfile $(call versioned_tag,$(STT_REPO)) -t $(STT_REPO):latest backend/apps/stt

	@printf "\n➤ Building summary service image...\n\n"
	@docker build -f backend/apps/summary/Dockerfile $(call versioned_tag,$(SUMMARY_REPO)) -t $(SUMMARY_REPO):latest backend/apps/summary

	@printf "\n➤ Building text-to-speech service image...\n\n"
	@docker build -f backend/apps/tts/Dockerfile $(call versioned_tag,$(TTS_REPO)) -t $(TTS_REPO):latest backend/apps/tts

	@printf "\n"

.PHONY: build-production
build-production: ## Build the application
	@printf "🧱 Building production images...\n\n"

	@printf "➤ Compiling API...\n\n"
	@cd backend/apps/api && yarn clean && yarn build

	@printf "\n➤ Compiling web frontend...\n\n"
	@cd frontend/apps/web && yarn clean && yarn build

	@printf "\n➤ Building API image...\n\n"
	@docker build -f backend/apps/api/Dockerfile $(call versioned_tag,$(API_REPO)) -t $(API_REPO):latest .

	@printf "\n➤ Building database setup image...\n\n"
	@docker build -f infrastructure/setup-database/Dockerfile $(call versioned_tag,$(SETUP_DATABASE_REPO)) -t $(SETUP_DATABASE_REPO):latest infrastructure/setup-database

	@printf "\n➤ Building database image...\n\n"
	@docker build -f infrastructure/database/Dockerfile $(call versioned_tag,$(DATABASE_REPO)) -t $(DATABASE_REPO):latest infrastructure/database

	@printf "\n➤ Building gateway image...\n\n"
	@docker build -f infrastructure/gateway/Dockerfile $(call versioned_tag,$(GATEWAY_REPO)) -t $(GATEWAY_REPO):latest .

	@printf "\n➤ Building object store image...\n\n"
	@docker build -f infrastructure/object-store/Dockerfile $(call versioned_tag,$(OBJECT_STORE_REPO)) -t $(OBJECT_STORE_REPO):latest infrastructure/object-store

	@printf "\n➤ Building orchestrator setup image...\n\n"
	@docker build -f infrastructure/setup-orchestrator/Dockerfile $(call versioned_tag,$(SETUP_ORCHESTRATOR_REPO)) -t $(SETUP_ORCHESTRATOR_REPO):latest infrastructure/setup-orchestrator

	@printf "\n➤ Building orchestrator image...\n\n"
	@docker build -f infrastructure/orchestrator/Dockerfile $(call versioned_tag,$(ORCHESTRATOR_REPO)) -t $(ORCHESTRATOR_REPO):latest infrastructure/orchestrator

	@printf "\n➤ Building setup secrets image...\n\n"
	@docker build -f infrastructure/setup-secrets/Dockerfile $(call versioned_tag,$(SETUP_SECRETS_REPO)) -t $(SETUP_SECRETS_REPO):latest infrastructure/setup-secrets

	@printf "\n➤ Building speech-to-text service image...\n\n"
	@docker build -f backend/apps/stt/Dockerfile $(call versioned_tag,$(STT_REPO)) -t $(STT_REPO):latest backend/apps/stt

	@printf "\n➤ Building summary service image...\n\n"
	@docker build -f backend/apps/summary/Dockerfile $(call versioned_tag,$(SUMMARY_REPO)) -t $(SUMMARY_REPO):latest backend/apps/summary

	@printf "\n➤ Building text-to-speech service image...\n\n"
	@docker build -f backend/apps/tts/Dockerfile $(call versioned_tag,$(TTS_REPO)) -t $(TTS_REPO):latest backend/apps/tts

	@printf "\n"

.PHONY: dbclear
dbclear: ## Clear the data stored in the PostgreSQL database
	@printf "🧻 Clearing PostgreSQL data...\n\n"

	@cd backend/apps/api && yarn db:clear

	@printf "\n"

.PHONY: dbdestroy
dbdestroy: ## Drop all PostgreSQL data including tables
	@printf "🧨 Destroying PostgreSQL database...\n\n"

	@cd backend/apps/api && yarn db:destroy

	@printf "\n"

.PHONY: dbshell
dbshell: ## Open a psql shell to the PostgreSQL database
	@yarn workspace @ci/be-api dbshell

.PHONY: deploy
deploy: ## DEPRECATED: Use production, staging, or local targets instead
	@$(MAKE) staging

.PHONY: dev
dev: local ## Run the development environment locally
	@which tmux >/dev/null || { printf "\n$(RED)✗$(RESET) You do not have tmux installed. Please install it first.\n\n"; exit 1; }
	@SESSION="companion"; \
	BACKEND_DIR="backend/apps/api"; \
	FRONTEND_DIR="frontend/apps/web"; \
	\
	if tmux has-session -t $$SESSION 2>/dev/null; then \
		printf "\n🔪 Killing existing tmux session: $$SESSION\n\n"; \
		tmux kill-session -t $$SESSION; \
	fi; \
	\
	printf "🚀 Starting new tmux session: $$SESSION\n\n"; \
	tmux new-session -d -s $$SESSION -c $$BACKEND_DIR; \
	tmux send-keys -t $$SESSION "yarn dev" C-m; \
	\
	tmux split-window -h -t $$SESSION -c $$FRONTEND_DIR; \
	tmux send-keys -t $$SESSION "yarn dev" C-m; \
	\
	tmux select-pane -t 0; \
	tmux attach -t $$SESSION

.PHONY: graphql
graphql: ## Generate GraphQL schema and frontend types
	@printf "🏷️ Generating GraphQL...\n"

	@yarn workspace @ci/be-api graphql:generate

	@printf "\n"

	@yarn workspace @ci/fe-web graphql:generate

	@printf "\nGraphQL successfully generated.\n\n"

.PHONY: health
health: ## Check the repository for prerequisites
	@printf "🩺 Checking health of prerequisites...\n\n"

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

	@OLLAMA=$$(which ollama 2>/dev/null); \
	if [ -z "$$OLLAMA" ]; then \
		printf "$(RED)✗$(RESET) You do not have 'ollama' installed or it is not in your PATH.\n\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) ollama found at $$OLLAMA 🦙\n\n"; \
	fi

	@if nc -z localhost 11434 > /dev/null 2>&1; then \
		printf "\t$(GREEN)✓$(RESET) ollama is running on port 11434\n\n"; \
	else \
		printf "\t$(RED)✗$(RESET) ollama is NOT running on port 11434. Please start ollama (e.g., 'ollama serve')\n\n"; \
		exit 1; \
	fi

	@MODEL=nomic-embed-text; \
	ollama list | grep -Fq "$$MODEL"; \
	STATUS=$$?; \
	if [ "$$STATUS" -eq 0 ]; then \
		printf "\t$(GREEN)✓$(RESET) ollama model '$$MODEL' is available\n\n"; \
	else \
		printf "\t$(RED)✗$(RESET) ollama model '$$MODEL' is not yet pulled\n\n"; \
		exit 1; \
	fi

	@MODEL=gemma3:1b; \
	ollama list | grep -Fq "$$MODEL"; \
	STATUS=$$?; \
	if [ "$$STATUS" -eq 0 ]; then \
		printf "\t$(GREEN)✓$(RESET) ollama model '$$MODEL' is available\n\n"; \
	else \
		printf "\t$(RED)✗$(RESET) ollama model '$$MODEL' is not yet pulled\n\n"; \
		exit 1; \
	fi

.PHONY: dev-health
dev-health: health ## Check the repository for prerequisites including development DNS resolutions
	@HOST=dev.companionintelligence.com; \
	IP=$$(ping -c 1 -W 1 $$HOST | grep -oE '\(([0-9:.]+)\)' | head -n1 | tr -d '()'); \
	if [ "$$IP" = "127.0.0.1" ] || [ "$$IP" = "::1" ]; then \
		printf "$(GREEN)✓$(RESET) $$HOST resolves to localhost ($$IP)\n\n"; \
	else \
		printf "$(RED)✗$(RESET) $$HOST resolves to $$IP (not localhost)\n\n"; \
		exit 1; \
	fi

.PHONY: init
init: ## Initialize repository after checkout
	@printf "🏗️ Initializing repository...\n\n"

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
	@printf "📦 Installing dependencies...\n\n"

	@yarn install

	@printf "\n"

.PHONY: redteam
redteam: ## Run Promptfoo red teaming against the local Ollama model
	@printf "🛡️ Running Promptfoo red team scan...\n\n"

	@yarn redteam

	@printf "\n"

.PHONY: local
local: dev-health init build-local stop ## Run the local deployment
	@printf "⌨️ Starting local services...\n\n"

	@docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local up -d --remove-orphans

	@printf "\n"

	@$(MAKE) migrate

.PHONY: migrate
migrate: ## Run database migrations
	@printf "🪿 Running database migrations...\n\n"

	@cd backend/apps/api && yarn migrate

	@printf "\nMigrations successfully run.\n\n"

.PHONY: production
production: health init build-production stop ## Run the production deployment
	@printf "🚀 Starting production services...\n\n"

	@docker compose -f docker-compose.yml -f docker-compose.production.yml --profile production up -d --remove-orphans

	@printf "\n"

.PHONY: seed
seed: ## Seed database with John Smith user and demo data
	@printf "🌱 Seeding database...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts

	@printf "\nDatabase successfully seeded. 🌳\n\n"

.PHONY: seed-production
seed-production: ## Seed production database via ephemeral proxy
	@printf "🌱 Seeding production database...\n\n"

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
staging: health init build-staging stop ## Run the staging deployment
	@printf "🎭 Starting staging services...\n\n"

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
	@printf "🛠️ Starting development tooling services...\n\n"

	@docker compose -f docker-compose.yml --profile tooling up -d

	@printf "\n"

#####################
# API ADMIN SCRIPTS #
#####################

.PHONY: gentoken
gentoken: ## Generates a stable access token for use during development
	@printf "🔑 Generating stable access token...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/generate-stable-access-token.ts

	@printf "\n"

.PHONY: signup
signup: ## Generates a set of signup codes for user registration
	@printf "👋 Generating signup codes...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/generate-signup-codes.ts

.PHONY: userpw
userpw: ## Change a user's password
	@printf "🔑 Changing user password...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/change-password.ts

	@printf "\n"

.PHONY: chatreset
chatreset: ## Reset John Smith's demo threads
	@printf "🧹 Resetting John Smith's demo threads...\n\n"

	@cd backend/apps/api && yarn db:chatreset

	@printf "\n"

.PHONY: filereset
filereset: ## Clear all files from the system
	@printf "🧹 Clearing all files from the system...\n\n"

	@cd backend/apps/api && yarn db:filereset

	@printf "\n"
