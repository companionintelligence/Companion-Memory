# shellcheck shell=bash
#
# A few attempts for the calls publish.sh and merge-manifests.sh make to the
# registry. Sourced, never run.
#
# GHCR fails a call now and then for reasons on its side. v2026.11.10's first
# publish (run 42886475612) lost the arm64 gateway push to "unknown blob" right
# after a layer was mounted from another repository. The other eight images
# pushed, and pushing again a few minutes later worked. Pushing an image, or
# writing a manifest list, a second time is safe: the registry skips layers it
# already has and the tag ends up on the same digest.
#
#   registry_retry <what> <command> [args...]
#
# Runs the command up to REGISTRY_ATTEMPTS times (default 3), waiting
# REGISTRY_RETRY_DELAY seconds (default 30) times the attempt number before
# each retry, so 30s and then 60s. After it returns, REGISTRY_OUTPUT holds the
# last attempt's stdout and REGISTRY_ERRORS its stderr. Each failed attempt
# that is retried prints a line and the tail of its output to stderr. The
# return status is the last attempt's.
#
# Plain bash 3.2, like images.sh: macOS runs this directory too.

registry_retry() {
  local what="$1"
  shift
  local attempts="${REGISTRY_ATTEMPTS:-3}"
  local delay="${REGISTRY_RETRY_DELAY:-30}"
  local attempt=1 status=0 pause err_file

  err_file="$(mktemp)"
  while true; do
    if REGISTRY_OUTPUT="$("$@" 2>"${err_file}")"; then
      status=0
    else
      status=$?
    fi
    REGISTRY_ERRORS="$(cat "${err_file}")"

    if [[ ${status} -eq 0 || ${attempt} -ge ${attempts} ]]; then
      rm -f "${err_file}"
      return "${status}"
    fi

    pause=$((delay * attempt))
    echo "  ⚠ ${what}: attempt ${attempt} of ${attempts} failed (exit ${status}), trying again in ${pause}s" >&2
    if [[ -n "${REGISTRY_OUTPUT}" ]]; then printf '%s\n' "${REGISTRY_OUTPUT}" | tail -n 5 >&2; fi
    if [[ -n "${REGISTRY_ERRORS}" ]]; then printf '%s\n' "${REGISTRY_ERRORS}" | tail -n 5 >&2; fi
    sleep "${pause}"
    attempt=$((attempt + 1))
  done
}
