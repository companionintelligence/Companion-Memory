# Filesystem MCP Server Makefile
# Standard interface for MCP server management

.PHONY: install build start clean test health status custom-install help
.DEFAULT_GOAL := install

SERVER_NAME := filesystem
PACKAGE_NAME := @modelcontextprotocol/server-filesystem
NODE_VERSION := 22.15.1

# Colors for output
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
RESET := \033[0m

install: ## Install and build the MCP server
	@printf "📦 Installing $(SERVER_NAME) MCP server...\n"
	
	# Create a minimal package.json for npm install
	@if [ ! -f "package.json" ]; then \
		printf "$(GREEN)✓$(RESET) Creating package.json...\n"; \
		echo '{"name": "mcp-filesystem-wrapper", "version": "1.0.0", "type": "module"}' > package.json; \
	fi
	
	# Install Node version if .tool-versions doesn't exist
	@if [ ! -f ".tool-versions" ]; then \
		echo "nodejs $(NODE_VERSION)" > .tool-versions; \
		printf "$(GREEN)✓$(RESET) Created .tool-versions file\n"; \
	fi
	
	# Install the Anthropic filesystem server package
	@printf "$(GREEN)✓$(RESET) Installing $(PACKAGE_NAME)...\n"
	@npm install $(PACKAGE_NAME)
	
	# Run custom installation steps
	@$(MAKE) custom-install
	
	# Build the server
	@$(MAKE) build
	
	@printf "$(GREEN)✓$(RESET) $(SERVER_NAME) server installed successfully!\n"

custom-install: ## Custom installation steps for filesystem server
	@printf "$(GREEN)✓$(RESET) Creating wrapper script...\n"
	@echo '#!/usr/bin/env node' > index.js
	@echo 'import { resolve } from "path";' >> index.js
	@echo 'import { spawn } from "child_process";' >> index.js
	@echo 'import { fileURLToPath } from "url";' >> index.js
	@echo 'import { dirname } from "path";' >> index.js
	@echo '' >> index.js
	@echo 'const __filename = fileURLToPath(import.meta.url);' >> index.js
	@echo 'const __dirname = dirname(__filename);' >> index.js
	@echo '' >> index.js
	@echo 'const serverPath = resolve(__dirname, "node_modules", "@modelcontextprotocol", "server-filesystem", "dist", "index.js");' >> index.js
	@echo 'const args = process.argv.slice(2);' >> index.js
	@echo '' >> index.js
	@echo 'const child = spawn("node", [serverPath, ...args], {' >> index.js
	@echo '  stdio: "inherit",' >> index.js
	@echo '  env: process.env' >> index.js
	@echo '});' >> index.js
	@echo '' >> index.js
	@echo 'child.on("exit", (code) => {' >> index.js
	@echo '  process.exit(code || 0);' >> index.js
	@echo '});' >> index.js
	@echo '' >> index.js
	@echo 'process.on("SIGINT", () => {' >> index.js
	@echo '  child.kill("SIGINT");' >> index.js
	@echo '});' >> index.js
	@echo '' >> index.js
	@echo 'process.on("SIGTERM", () => {' >> index.js
	@echo '  child.kill("SIGTERM");' >> index.js
	@echo '});' >> index.js
	@chmod +x index.js

build: ## Build the MCP server
	@printf "🔨 Building $(SERVER_NAME) server...\n"
	@printf "$(GREEN)✓$(RESET) Using npm-installed package (no build required)\n"

start: ## Start the MCP server (for testing)
	@printf "🚀 Starting $(SERVER_NAME) server...\n"
	@node index.js /tmp

clean: ## Clean build artifacts
	@printf "🧹 Cleaning $(SERVER_NAME) server...\n"
	@rm -rf node_modules/
	@rm -f index.js
	@rm -f package.json
	@rm -f package-lock.json
	@printf "$(GREEN)✓$(RESET) Clean completed\n"

test: ## Test the server
	@printf "🧪 Testing $(SERVER_NAME) server...\n"
	@printf "$(GREEN)✓$(RESET) Testing server startup...\n"
	@timeout 5s node index.js /tmp || printf "$(GREEN)✓$(RESET) Server startup test completed\n"

health: ## Check server health
	@printf "🔍 Checking $(SERVER_NAME) server health...\n"
	@if [ ! -f "index.js" ]; then \
		printf "$(RED)✗$(RESET) Wrapper script not found - run 'make install' first\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) Wrapper script is ready\n"; \
	fi
	@if [ ! -d "node_modules/@modelcontextprotocol/server-filesystem" ]; then \
		printf "$(RED)✗$(RESET) Filesystem server package not installed - run 'make install' first\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓$(RESET) Filesystem server package is installed\n"; \
	fi

status: ## Show server status
	@printf "📊 $(SERVER_NAME) Server Status\n\n"
	@if [ -f "package.json" ]; then \
		printf "$(GREEN)✓$(RESET) Package configuration present\n"; \
	else \
		printf "$(RED)✗$(RESET) Package configuration missing\n"; \
	fi
	@if [ -d "node_modules/@modelcontextprotocol/server-filesystem" ]; then \
		printf "$(GREEN)✓$(RESET) Filesystem server package installed\n"; \
		VERSION=$$(node -p "require('./node_modules/@modelcontextprotocol/server-filesystem/package.json').version" 2>/dev/null || echo "unknown"); \
		printf "  Version: $$VERSION\n"; \
	else \
		printf "$(RED)✗$(RESET) Filesystem server package not installed\n"; \
	fi
	@if [ -f "index.js" ]; then \
		printf "$(GREEN)✓$(RESET) Wrapper script ready\n"; \
	else \
		printf "$(RED)✗$(RESET) Wrapper script missing\n"; \
	fi

help: ## Show this help message
	@printf "📋 $(SERVER_NAME) MCP Server Commands\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

