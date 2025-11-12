# Makefile for CI-Memory Service
# Quick commands for common operations

.PHONY: help build up down logs restart test-trigger clean rebuild

help:
	@echo "CI-Memory Service - Available Commands:"
	@echo ""
	@echo "  make build         - Build the memory-service container"
	@echo "  make up            - Start the memory-service"
	@echo "  make down          - Stop the memory-service"
	@echo "  make logs          - View memory-service logs (follow mode)"
	@echo "  make restart       - Restart the memory-service"
	@echo "  make test-trigger  - Test the manual summary trigger"
	@echo "  make clean         - Stop and remove memory-service container"
	@echo "  make rebuild       - Clean rebuild and restart"
	@echo ""

build:
	@echo "Building memory-service container..."
	docker-compose build memory-service

up:
	@echo "Starting memory-service..."
	docker-compose up -d memory-service
	@echo "Service started on http://localhost:8001"
	@echo "View logs with: make logs"
	@echo "View API docs: http://localhost:8001/docs"

down:
	@echo "Stopping memory-service..."
	docker-compose stop memory-service

logs:
	@echo "Following memory-service logs (Ctrl+C to exit)..."
	docker-compose logs -f memory-service

restart: down up
	@echo "Memory-service restarted"

test-trigger:
	@echo "Testing manual summary trigger..."
	@echo "Note: You need to set USER_ID environment variable"
	@bash -c 'if [ -z "$$USER_ID" ]; then echo "ERROR: USER_ID not set. Usage: USER_ID=<uuid> make test-trigger"; exit 1; fi'
	@bash test_manual_summary.sh

clean:
	@echo "Cleaning up memory-service..."
	docker-compose down memory-service
	@echo "Cleanup complete"

rebuild: clean build up
	@echo "Rebuild complete"
