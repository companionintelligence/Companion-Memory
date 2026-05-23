#!/usr/bin/env bash
# ermy-memory-setup.sh
#
# Set up the Companion Intelligence memory plugin for the Ermy / Hermes agent.
#
# Usage:
#   ./scripts/ermy-memory-setup.sh [--dry-run]
#
# Flags:
#   --dry-run   Print what would happen without making any changes.
#
# Environment:
#   COMPANION_API_KEY   Required. Your Companion Intelligence API key.
#   COMPANION_BASE_URL  Optional. Defaults to https://api.companion.intelligence
#   COMPANION_AGENT_ID  Optional. A stable identifier for this agent instance.

set -euo pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

DRY_RUN=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLUGIN_DIR="${REPO_ROOT}/plugins/hermes-companion-memory"
DEFAULT_BASE_URL="https://api.companion.intelligence"
HERMES_CONFIG="${HOME}/.hermes/config.yaml"
HERMES_PLUGINS_DIR="${HOME}/.hermes/plugins"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()    { echo "[INFO]  $*"; }
warn()    { echo "[WARN]  $*" >&2; }
error()   { echo "[ERROR] $*" >&2; }
success() { echo "[OK]    $*"; }

# Print what would happen vs. actually do it.
maybe_run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] would run: $*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

for arg in "$@"; do
  case "${arg}" in
    --dry-run)
      DRY_RUN=true
      ;;
    -h|--help)
      grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      error "Unknown argument: ${arg}"
      exit 1
      ;;
  esac
done

if [[ "${DRY_RUN}" == "true" ]]; then
  info "Dry-run mode enabled — no changes will be made."
fi

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

check_dependency() {
  local cmd="$1"
  local install_hint="$2"
  if ! command -v "${cmd}" &>/dev/null; then
    error "'${cmd}' is required but not installed."
    echo "  Install it with: ${install_hint}"
    exit 1
  fi
  success "${cmd} is available ($(${cmd} --version 2>&1 | head -1))"
}

info "Checking required dependencies..."

check_dependency jq  "brew install jq   (macOS) | apt-get install jq   (Debian/Ubuntu)"
check_dependency yq  "brew install yq   (macOS) | apt-get install yq   (Debian/Ubuntu)"

if ! command -v python3 &>/dev/null; then
  error "'python3' is required but not installed."
  exit 1
fi
success "python3 is available ($(python3 --version))"

# ---------------------------------------------------------------------------
# API key validation
# ---------------------------------------------------------------------------

info "Checking COMPANION_API_KEY..."

if [[ -z "${COMPANION_API_KEY:-}" ]]; then
  error "COMPANION_API_KEY is not set."
  echo ""
  echo "  Please export your Companion Intelligence API key:"
  echo "    export COMPANION_API_KEY='your-api-key-here'"
  echo ""
  echo "  Obtain a key from: https://companion.intelligence/dashboard"
  exit 1
fi

# Mask the key for display: show only the last 4 chars.
MASKED_KEY="***${COMPANION_API_KEY: -4}"
success "COMPANION_API_KEY is set (${MASKED_KEY})"

BASE_URL="${COMPANION_BASE_URL:-${DEFAULT_BASE_URL}}"
AGENT_ID="${COMPANION_AGENT_ID:-}"

info "Base URL : ${BASE_URL}"
info "Agent ID : ${AGENT_ID:-<not set>}"

# ---------------------------------------------------------------------------
# Install Python package
# ---------------------------------------------------------------------------

info "Installing hermes-companion-memory Python package..."

if [[ ! -d "${PLUGIN_DIR}" ]]; then
  error "Plugin directory not found: ${PLUGIN_DIR}"
  exit 1
fi

maybe_run pip install --quiet -e "${PLUGIN_DIR}"
success "hermes-companion-memory installed"

# ---------------------------------------------------------------------------
# Create Hermes plugin directory
# ---------------------------------------------------------------------------

info "Creating Hermes plugins directory: ${HERMES_PLUGINS_DIR}"
maybe_run mkdir -p "${HERMES_PLUGINS_DIR}"

# ---------------------------------------------------------------------------
# Write / merge plugin registration into Hermes config
# ---------------------------------------------------------------------------

info "Configuring Hermes memory plugin in ${HERMES_CONFIG}..."

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[DRY-RUN] would write companion plugin entry to ${HERMES_CONFIG}"
else
  mkdir -p "$(dirname "${HERMES_CONFIG}")"

  if [[ ! -f "${HERMES_CONFIG}" ]]; then
    info "Hermes config not found — creating a new one."
    cat > "${HERMES_CONFIG}" <<YAML
# Hermes Agent configuration
# Auto-generated by ermy-memory-setup.sh

memory:
  providers:
    - name: companion
      enabled: true
      config:
        api_key: "${COMPANION_API_KEY}"
        base_url: "${BASE_URL}"
YAML
  else
    # Config exists — use yq to merge in the companion provider if absent.
    existing_providers=$(yq '.memory.providers[].name' "${HERMES_CONFIG}" 2>/dev/null || echo "")
    if echo "${existing_providers}" | grep -q "^companion$"; then
      warn "companion provider already registered in ${HERMES_CONFIG} — skipping (not overwriting existing key)."
    else
      info "Adding companion provider to existing config..."
      yq -i '.memory.providers += [{"name": "companion", "enabled": true, "config": {"api_key": env(COMPANION_API_KEY), "base_url": env(BASE_URL)}}]' "${HERMES_CONFIG}"
    fi
  fi

  success "Hermes config updated: ${HERMES_CONFIG}"
fi

# ---------------------------------------------------------------------------
# Write env-var snippet for shell profile
# ---------------------------------------------------------------------------

PROFILE_SNIPPET="
# Companion Intelligence memory plugin
export COMPANION_API_KEY=\"${COMPANION_API_KEY}\"
export COMPANION_BASE_URL=\"${BASE_URL}\"
$([ -n "${AGENT_ID}" ] && echo "export COMPANION_AGENT_ID=\"${AGENT_ID}\"")"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo ""
  echo "[DRY-RUN] The following would be appended to your shell profile (~/.zshrc or ~/.bashrc):"
  echo "${PROFILE_SNIPPET}"
  echo ""
else
  # Detect shell profile.
  if [[ "${SHELL}" == */zsh ]]; then
    PROFILE="${HOME}/.zshrc"
  else
    PROFILE="${HOME}/.bashrc"
  fi

  if grep -q "COMPANION_API_KEY" "${PROFILE}" 2>/dev/null; then
    warn "COMPANION_API_KEY already present in ${PROFILE} — not overwriting."
  else
    info "Appending environment variables to ${PROFILE}..."
    echo "${PROFILE_SNIPPET}" >> "${PROFILE}"
    success "Shell profile updated: ${PROFILE}"
    info "Run 'source ${PROFILE}' or start a new shell to apply."
  fi
fi

# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

info "Running smoke test (hermes companion status)..."
if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[DRY-RUN] would run: hermes companion status"
else
  if command -v hermes &>/dev/null; then
    hermes companion status || warn "hermes companion status returned non-zero (API key may be invalid)."
  else
    warn "'hermes' binary not found in PATH — skipping smoke test."
    info "Once Hermes is installed, run: hermes companion status"
  fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
success "ermy-memory-setup complete."
echo ""
echo "  Next steps:"
echo "    1. Reload your shell: source ~/.zshrc (or ~/.bashrc)"
echo "    2. Start Hermes and confirm: hermes companion status"
echo ""
