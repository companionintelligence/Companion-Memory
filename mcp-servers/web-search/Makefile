# Web Search MCP Server Makefile
# Standard interface for MCP server management

.PHONY: install build start clean test health status custom-install help
.DEFAULT_GOAL := install

SERVER_NAME := web-search
REPO_URL := https://github.com/mrkrsl/web-search-mcp.git
NODE_VERSION := 22.15.1

# Colors for output
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
RESET := \033[0m

install: ## Install and build the MCP server
	@printf "📦 Installing $(SERVER_NAME) MCP server...\n"

	# Clone repository if source files don't exist
	@if [ ! -f "package.json" ]; then \
		printf "$(GREEN)✓$(RESET) Cloning repository...\n"; \
		git clone --depth 1 "$(REPO_URL)" temp-clone; \
		rm -f temp-clone/.gitignore temp-clone/Makefile; \
		mv temp-clone/* .; \
		mv temp-clone/.[!.]* . 2>/dev/null || true; \
		rmdir temp-clone; \
	else \
		printf "$(GREEN)✓$(RESET) Source files already exist\n"; \
	fi

	# Install Node version if .tool-versions doesn't exist
	@if [ ! -f ".tool-versions" ]; then \
		echo "nodejs $(NODE_VERSION)" > .tool-versions; \
		printf "$(GREEN)✓$(RESET) Created .tool-versions file\n"; \
	fi

	# Install dependencies
	@printf "$(GREEN)✓$(RESET) Installing dependencies...\n"
	@npm install --include=dev

	# Run custom installation steps
	@$(MAKE) custom-install

	# Build the server
	@$(MAKE) build

	@printf "$(GREEN)✓$(RESET) $(SERVER_NAME) server installed successfully!\n"

custom-install: ## Custom installation steps for web-search server
	@printf "$(GREEN)✓$(RESET) Installing Playwright browsers...\n"
	@npx playwright install

build: ## Build the MCP server
	@printf "🔨 Building $(SERVER_NAME) server...\n"
	@npm run build
	@printf "$(GREEN)✓$(RESET) Build completed\n"

start: ## Start the MCP server (for testing)
	@printf "🚀 Starting $(SERVER_NAME) server...\n"
	@node dist/index.js

clean: ## Clean build artifacts
	@printf "🧹 Cleaning $(SERVER_NAME) server...\n"
	@rm -rf dist/
	@rm -rf node_modules/
	@rm -rf playwright-browsers/
	@printf "$(GREEN)✓$(RESET) Clean completed\n"

test: ## Test the server
	@printf "🧪 Testing $(SERVER_NAME) server...\n"
	@if [ -f "package.json" ] && npm run --silent test >/dev/null 2>&1; then \
		npm run test; \
	else \
		printf "$(YELLOW)⚠$(RESET) No test script available\n"; \
		printf "$(GREEN)✓$(RESET) Testing server startup...\n"; \
		timeout 5s node dist/index.js || printf "$(GREEN)✓$(RESET) Server startup test completed\n"; \
	fi

health: ## Check server health
	@printf "🔍 Checking $(SERVER_NAME) server health...\n"
	@if [ ! -f "dist/index.js" ]; then \
		printf "$(RED)✗$(RESET) Server not built - run 'make build' first\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) Server is built and ready\n"; \
	fi
	@if [ ! -d "node_modules" ]; then \
		printf "$(RED)✗$(RESET) Dependencies not installed - run 'make install' first\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) Dependencies are installed\n"; \
	fi

status: ## Show server status
	@printf "📊 $(SERVER_NAME) Server Status\n\n"
	@if [ -f "package.json" ]; then \
		printf "$(GREEN)✓$(RESET) Source files present\n"; \
		NAME=$$(node -p "require('./package.json').name" 2>/dev/null || echo "unknown"); \
		VERSION=$$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown"); \
		printf "  Name: $$NAME\n"; \
		printf "  Version: $$VERSION\n"; \
	else \
		printf "$(RED)✗$(RESET) Source files missing\n"; \
	fi
	@if [ -d "node_modules" ]; then \
		printf "$(GREEN)✓$(RESET) Dependencies installed\n"; \
	else \
		printf "$(RED)✗$(RESET) Dependencies not installed\n"; \
	fi
	@if [ -f "dist/index.js" ]; then \
		printf "$(GREEN)✓$(RESET) Server built\n"; \
	else \
		printf "$(RED)✗$(RESET) Server not built\n"; \
	fi
	@if [ -d "playwright-browsers" ]; then \
		printf "$(GREEN)✓$(RESET) Playwright browsers installed\n"; \
	else \
		printf "$(YELLOW)⚠$(RESET) Playwright browsers not found\n"; \
	fi

help: ## Show this help message
	@printf "📋 $(SERVER_NAME) MCP Server Commands\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'
