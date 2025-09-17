.PHONY: help build dbclear dbdestroy dev index infra init install local migrate seed staging gentoken useradd userpw
.DEFAULT_GOAL := help

RED=\033[0;31m
GREEN=\033[0;32m
YELLOW=\033[0;33m
RESET=\033[0m

export API_REPO ?= ci/api
export WEBSERVER_REPO ?= ci/nginx
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

# Sourced from: https://marmelab.com/blog/2016/02/29/auto-documented-makefile.html
help: ## List make commands with their descriptions
	@printf "$$BANNER\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

build: ## Build the application
	@printf "🧱 Building the application...\n\n"

	@printf "Compiling API...\n\n"
	@cd backend/apps/api && yarn clean && yarn build
	@printf "\nAPI successfully compiled.\n"

	@printf "\nCompiling web frontend...\n\n"
	@cd frontend/apps/web && yarn clean && yarn build
	@printf "\nWeb frontend successfully compiled.\n"

	@printf "\nBuilding API Docker image...\n\n"
	@docker build -f backend/apps/api/Dockerfile -t $(API_REPO):latest .
	@printf "\nAPI Docker image successfully built.\n"

	@printf "\nBuilding webserver Docker image...\n\n"
	@docker build -f docker/webserver/Dockerfile -t $(WEBSERVER_REPO):latest .
	@printf "\nWebserver Docker image successfully built.\n"

	@printf "\nApplication successfully built.\n"

infra: ## Boot the local infrastructure
	@printf "🐳 Starting Docker dependencies...\n\n"
	@docker compose --profile infra up -d
	@printf "\nDocker dependencies successfully started.\n"

dbclear: ## Clear the PostgreSQL database and start from scratch
	@printf "🧻 Clearing PostgreSQL data...\n\n"
	@cd backend/apps/api && yarn db:clear
	@printf "\nData successfully cleared.\n"

dbdestroy: ## Clear the PostgreSQL database and start from scratch
	@printf "🧨 Destroying PostgreSQL database...\n\n"
	@cd backend/apps/api && yarn db:destroy
	@printf "\nDatabase successfully destroyed. 💥\n"

dev: ## Boot the application
	@which tmux >/dev/null || { printf "\n$(RED)✗$(RESET) You do not have tmux installed. Please install it first.\n\n"; exit 1; };

	$(MAKE) infra
	$(MAKE) local

	@SESSION="companion"; \
	BACKEND_DIR="backend/apps/api"; \
	FRONTEND_DIR="frontend/apps/web"; \
	\
	if tmux has-session -t $$SESSION 2>/dev/null; then \
		printf "\n🔪 Killing existing tmux session: $$SESSION\n\n"; \
		tmux kill-session -t $$SESSION; \
		printf "You can now re-run: make dev\n"; \
		exit 0; \
	fi; \
	\
	printf "🚀 Starting new tmux session: $$SESSION\n\n"; \
	tmux new-session -d -s $$SESSION -c $$BACKEND_DIR; \
	tmux send-keys -t $$SESSION "yarn dev:pretty" C-m; \
	\
	tmux split-window -h -t $$SESSION -c $$FRONTEND_DIR; \
	tmux send-keys -t $$SESSION "yarn dev" C-m; \
	\
	tmux select-pane -t 0; \
	tmux attach -t $$SESSION

index: ## Generate vector embeddings for indexable content
	@printf "🗂 Indexing database...\n\n"
	@cd backend/apps/api && yarn run exec -- scripts/bulk-generate-embeddings.ts
	@printf "\nDatabase successfully indexed.\n"

init: ## Initialize repository after checkout
	@printf "🏗️ Initializing repository...\n\n"

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

	@HOST=dev.companionintelligence.com; \
	IP=$$(ping -c 1 -W 1 $$HOST | grep -oE '\(([0-9:.]+)\)' | head -n1 | tr -d '()'); \
	if [ "$$IP" = "127.0.0.1" ] || [ "$$IP" = "::1" ]; then \
		printf "$(GREEN)✓$(RESET) $$HOST resolves to localhost ($$IP)\n\n"; \
	else \
		printf "$(RED)✗$(RESET) $$HOST resolves to $$IP (not localhost)\n\n"; \
		exit 1; \
	fi

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
	@printf "\n"
	@printf "\nRepository initialized.\n"

install: ## Install project dependencies
	@printf "📦 Installing dependencies...\n\n"
	@yarn install
	@printf "\nDependencies successfully installed.\n"

local: ## Run the local dependencies from Docker images
	@printf "⌨️ Starting the local services...\n\n"
	@docker compose --profile staging down
	@docker compose --profile local up -d
	@printf "\nLocal services successfully started.\n"

migrate: ## Run database migrations
	@printf "🪿 Running database migrations...\n\n"
	@cd backend/apps/api && yarn migrate
	@printf "\nMigrations successfully run.\n"

seed: ## Seed backend database
	@printf "🌱 Seeding database...\n\n"
	@cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts
	@printf "\nDatabase successfully seeded. 🌳\n"

staging: ## Run the staging server from Docker images
	@printf "🎭 Starting the staging services...\n\n"
	@docker compose --profile local down
	@docker compose --profile staging up -d
	@printf "\nStaging services successfully started.\n"

#####################
# API ADMIN SCRIPTS #
#####################

gentoken: ## Generates a stable access token for use during development
	@printf "🔑 Generating stable access token...\n\n"
	@cd backend/apps/api && yarn run exec -- scripts/generate-stable-access-token.ts

useradd: ## Add a user to the PostgreSQL database
	@printf "👤 Adding user...\n\n"
	@cd backend/apps/api && yarn run exec -- scripts/add-user.ts

userpw: ## Change a user's password
	@printf "🔑 Changing user password...\n\n"
	@cd backend/apps/api && yarn run exec -- scripts/change-password.ts
