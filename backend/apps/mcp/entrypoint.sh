#!/bin/sh
set -e

SECRETS_FILE="${SECRETS_FILE:-/run/secrets/.env.secrets}"

get_secret() {
  [ -f "$SECRETS_FILE" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in \#*|"") continue ;; esac
    if [ "$key" = "$1" ]; then
      printf '%s' "$value" | tr -d '\r'
      return
    fi
  done < "$SECRETS_FILE"
}

: "${CI_API_SERVICE_KEY:=$(get_secret CI_API_SERVICE_KEY)}"
: "${CI_MCP_AUTH_TOKEN:=$(get_secret CI_MCP_AUTH_TOKEN)}"
: "${CI_API_BASE_URL:=http://api:3030}"
: "${CI_MCP_PORT:=3091}"

export CI_API_SERVICE_KEY CI_MCP_AUTH_TOKEN CI_API_BASE_URL CI_MCP_PORT CI_OWNER_USER_ID

if [ -z "$CI_API_SERVICE_KEY" ]; then
  echo "Error: CI_API_SERVICE_KEY is not set."
  exit 1
fi

if [ -z "$CI_MCP_AUTH_TOKEN" ]; then
  echo "Error: CI_MCP_AUTH_TOKEN is not set."
  exit 1
fi

exec "$@"
