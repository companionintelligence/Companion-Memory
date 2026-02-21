.DEFAULT_GOAL := help

RED=\033[0;31m
GREEN=\033[0;32m
YELLOW=\033[0;33m
RESET=\033[0m

export API_REPO ?= ci/companion-api
export WEBSERVER_REPO ?= ci/companion-server
export TAG ?= $(shell git rev-parse --short HEAD 2>/dev/null)

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
	@printf "🧹 Resetting local development environment INCLUDING DATABASE DATA...\n\n"

	@COMPOSE_CONTAINERS=$$(docker compose ps -aq 2>/dev/null); \
	if [ -n "$$COMPOSE_CONTAINERS" ]; then \
		printf "► Stopping existing containers...\n\n"; \
		docker stop $$COMPOSE_CONTAINERS 2>/dev/null || true; \
		printf "\n► Removing containers...\n\n"; \
		docker rm -f $$COMPOSE_CONTAINERS 2>/dev/null || true; \
		printf "\n"; \
	fi

	@docker compose down -v --remove-orphans 2>/dev/null || true

	@COMPOSE_CONTAINERS=$$(docker compose ps -aq 2>/dev/null); \
	if [ -n "$$COMPOSE_CONTAINERS" ]; then \
		printf "\n► Removing remaining containers...\n\n"; \
		docker rm -f $$COMPOSE_CONTAINERS 2>/dev/null || true; \
		printf "\n"; \
	fi

	@printf "► Removing Docker volumes...\n\n"
	@COMPOSE_VOLUMES="postgres-data minio-data stt-service-models stt-service-cache tts-service-models tts-service-cache"; \
	for vol in $$COMPOSE_VOLUMES; do \
		docker volume ls -q | grep "^ci-server_$$vol$$" | xargs -r docker volume rm -f 2>/dev/null || true; \
	done; \

	@printf "\n► Removing Docker images...\n\n"
	@docker rmi -f ci/companion-server ci/companion-api ci/postgres ci/stt-service ci/summary-service ci/tts-service ci/nginx 2>/dev/null || true

	@printf "\n► Pruning Docker networks...\n\n"
	@docker network prune --force 2>/dev/null || true

.PHONY: build
build: ## Build the application
	@printf "🧱 Building the application...\n\n"

	@printf "► Building PostgreSQL image...\n\n"
	@docker compose build postgres

	@printf "\n► Building Speech-to-text service image...\n\n"
	@docker compose build stt-service

	@printf "\n► Building Text-to-speech service image...\n\n"
	@docker compose build tts-service

	@printf "\n► Building Summary service image...\n\n"
	@docker compose build summary-service

	@printf "\n► Compiling API...\n\n"
	@cd backend/apps/api && yarn clean && yarn build

	@printf "\n► Building API image...\n\n"
	@docker build -f backend/apps/api/Dockerfile -t $(API_REPO):latest .

	@printf "\n► Compiling web frontend...\n\n"
	@cd frontend/apps/web && yarn clean && yarn build

	@printf "\n► Building webserver image...\n\n"
	@docker build -f infrastructure/nginx/Dockerfile.staging -t $(WEBSERVER_REPO):latest .

	@printf "\nApplication successfully built.\n\n"

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
	@HOST=portal.companionintelligence.com; \
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

.PHONY: local
local: dev-health init stop ## Run the local deployment
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
production: health init build stop ## Run the production deployment
	@printf "🚀 Starting production services...\n\n"

	@docker compose -f docker-compose.yml -f docker-compose.production.yml --profile production up -d --remove-orphans

	@printf "\n"

.PHONY: seed
seed: ## Seed database with John Smith user and demo data
	@printf "🌱 Seeding database...\n\n"

	@cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts

	@printf "\nDatabase successfully seeded. 🌳\n\n"

.PHONY: staging
staging: health init build stop ## Run the staging deployment
	@printf "🎭 Starting staging services...\n\n"

	@docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile staging up -d --remove-orphans

	@printf "\n"

.PHONY: stop
stop: ## Stop all running services
	@printf "🛑 Stopping all running services... "

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
