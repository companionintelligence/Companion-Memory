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
# REGISTRY_RETRY_DELAY seconds (default 60) times the attempt number before
# each retry, so 60s and then 120s. The rerun that worked in run 42886475612
# came a few minutes after the failure, so the waits are not shorter than
# that. After it returns, REGISTRY_OUTPUT holds the last attempt's stdout and
# REGISTRY_ERRORS its stderr. Each failed attempt that is retried prints a line
# and the tail of its output to stderr. The return status is the last
# attempt's.
#
# A refusal is not retried: when the output says denied, unauthorized,
# forbidden or insufficient_scope, the call returns at once. A token without
# packages:write would otherwise wait three minutes on each of nine images. If
# the registry words a refusal differently, the call is retried as before.
#
# Both settings must be plain whole numbers. In $(( )) a value like "30s" or
# "1.5" is an arithmetic error, and bash answers one by abandoning the caller's
# whole if/else, so merge-manifests.sh would skip every image and still print
# its "✓ All N images" line. A bad value fails the call with status 2 before
# the command runs, with the reason in REGISTRY_ERRORS.
#
#   registry_report
#
# Prints the last attempt's stdout and stderr to stderr, skipping whichever is
# empty. For the caller's failure path.
#
# Plain bash 3.2, like images.sh: macOS runs this directory too.

registry_retry() {
  local what="$1"
  shift
  local attempts="${REGISTRY_ATTEMPTS:-3}"
  local delay="${REGISTRY_RETRY_DELAY:-60}"
  local attempt=1 status=0 pause err_file
  local count_re='^[1-9][0-9]*$' seconds_re='^(0|[1-9][0-9]*)$'

  REGISTRY_OUTPUT=''
  REGISTRY_ERRORS=''
  if [[ ! "${attempts}" =~ ${count_re} ]]; then
    REGISTRY_ERRORS="REGISTRY_ATTEMPTS must be a whole number of at least 1, not '${attempts}'"
    return 2
  fi
  if [[ ! "${delay}" =~ ${seconds_re} ]]; then
    REGISTRY_ERRORS="REGISTRY_RETRY_DELAY must be a whole number of seconds, not '${delay}'"
    return 2
  fi

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

    if printf '%s\n%s\n' "${REGISTRY_OUTPUT}" "${REGISTRY_ERRORS}" \
      | grep -qiE 'denied|unauthorized|forbidden|insufficient_scope'; then
      echo "  ⚠ ${what}: the registry refused it (exit ${status}), not trying again" >&2
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

registry_report() {
  if [[ -n "${REGISTRY_OUTPUT:-}" ]]; then printf '%s\n' "${REGISTRY_OUTPUT}" >&2; fi
  if [[ -n "${REGISTRY_ERRORS:-}" ]]; then printf '%s\n' "${REGISTRY_ERRORS}" >&2; fi
}
