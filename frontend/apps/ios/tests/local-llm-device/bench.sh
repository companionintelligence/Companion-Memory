#!/usr/bin/env bash
# Drives the on-device LLM bench on a physical iPhone. See README.md.
#
#   bench.sh build                      build the bench app (Release) for a device
#   bench.sh install                    install it (a separate bundle id: no installed app is touched)
#   bench.sh models <dir>               push the two catalog model files from <dir> into the bench's container
#   bench.sh run <plan.json>            run a plan on the phone and pull its results into ./results
#   bench.sh pull <plan-id>             pull a plan's results and log without running anything
#
# The phone has to be unlocked to LAUNCH the app (install and file copies work locked), and it has to
# stay awake and plugged in while a plan runs: a long plan is minutes to hours of sustained CPU.
#
# Environment: BENCH_DEVICE (a UDID, name or ECID; default: the one connected iPhone), BENCH_OUT
# (default ./results), BENCH_DERIVED_DATA (default ./.build), BENCH_POLL_SECONDS (default 20).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bundle_id="com.companionintelligence.app.llmbench"
derived="${BENCH_DERIVED_DATA:-$here/.build}"
out="${BENCH_OUT:-$here/results}"
export LANG="${LANG:-en_US.UTF-8}" LC_ALL="${LC_ALL:-en_US.UTF-8}"

device() {
  if [ -n "${BENCH_DEVICE:-}" ]; then
    echo "$BENCH_DEVICE"
    return
  fi

  local json
  json="$(mktemp)"
  xcrun devicectl list devices --json-output "$json" >/dev/null 2>&1 || true
  python3 - "$json" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1])).get("result", {}).get("devices", [])
phones = [d for d in devices
          if d.get("hardwareProperties", {}).get("reality") == "physical"
          and d.get("hardwareProperties", {}).get("deviceType") == "iPhone"]
if not phones:
    sys.exit("no physical iPhone found; connect one or set BENCH_DEVICE")
print(phones[0]["hardwareProperties"]["udid"])
PY
  rm -f "$json"
}

to_device() { # <local file> <path inside Documents or Library>
  xcrun devicectl device copy to --device "$(device)" --source "$1" --destination "$2" \
    --domain-type appDataContainer --domain-identifier "$bundle_id" >/dev/null
}

from_device() { # <path inside the container> <local dir>
  mkdir -p "$2"
  xcrun devicectl device copy from --device "$(device)" --source "$1" --destination "$2" \
    --domain-type appDataContainer --domain-identifier "$bundle_id" >/dev/null 2>&1
}

app_path() { echo "$derived/Build/Products/Release-iphoneos/LocalLLMBench.app"; }

cmd_build() {
  command -v xcodegen >/dev/null || { echo "xcodegen is needed: brew install xcodegen" >&2; exit 1; }
  local fw="$here/../../ios/App/Frameworks/CLiteRTLM.xcframework"
  [ -d "$fw" ] || { echo "missing $fw: run ios/App/Frameworks/fetch-clitertlm-xcframework.sh" >&2; exit 1; }

  (cd "$here" && xcodegen generate >/dev/null)
  xcodebuild -project "$here/LocalLLMBench.xcodeproj" -scheme LocalLLMBench -configuration Release \
    -destination "id=$(device)" -derivedDataPath "$derived" build | tail -3
}

cmd_install() {
  xcrun devicectl device install app --device "$(device)" "$(app_path)" | tail -3
}

cmd_models() {
  local dir="${1:?usage: bench.sh models <dir with the two .litertlm files>}"
  local file
  for file in Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm \
    Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.litertlm; do
    [ -f "$dir/$file" ] || { echo "missing $dir/$file" >&2; exit 1; }
    echo "pushing $file"
    to_device "$dir/$file" "Library/Application Support/local-llm-models/$file"
  done
}

plan_id() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$1"
}

pull_status() { # <plan-id>: the small files a poll needs
  local id="$1" f
  mkdir -p "$out"
  rm -f "$out/DONE-$id"
  for f in "status-$id.json" "DONE-$id"; do
    from_device "Documents/bench/$f" "$out" || true
  done
}

cmd_pull() {
  local id="${1:?usage: bench.sh pull <plan-id>}"
  local f
  mkdir -p "$out"
  for f in "results-$id.jsonl" "status-$id.json" "bench.log" "DONE-$id"; do
    from_device "Documents/bench/$f" "$out" || true
  done
}

app_running() {
  xcrun devicectl device info processes --device "$(device)" 2>/dev/null |
    grep -q "LocalLLMBench.app/LocalLLMBench"
}

# Starts the app. A locked phone and a dropped connection are waited out: a plan can be started hours
# before anyone is at the phone. Anything else is a real error.
launch_app() {
  local log="$out/launch.log" attempts=0
  mkdir -p "$out"
  while true; do
    if xcrun devicectl device process launch --device "$(device)" --terminate-existing \
      "$bundle_id" >"$log" 2>&1; then
      return 0
    fi

    if grep -q "Locked" "$log"; then
      echo "waiting for the phone to be unlocked… ($(date +%T))"
    elif grep -q "not been explicitly trusted" "$log"; then
      echo "on the phone: Settings › General › VPN & Device Management › trust the developer ($(date +%T))"
    elif grep -qE "could not be established|XPC connection|unavailable|NWError|timed out" "$log"; then
      echo "lost the connection to the phone, retrying… ($(date +%T))"
    else
      cat "$log" >&2
      return 1
    fi

    attempts=$((attempts + 1))
    if [ "$attempts" -ge "${BENCH_LAUNCH_ATTEMPTS:-720}" ]; then
      echo "gave up launching after $attempts attempts" >&2
      return 1
    fi
    sleep 10
  done
}

# Runs a command that talks to the phone until it succeeds: a plan lasts hours, and the connection to the
# phone drops (a network timeout, the phone going to sleep) without anything being wrong with the run.
retry() { # <attempts> <command…>
  local attempts="$1" tries=0
  shift

  until "$@"; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$attempts" ]; then
      echo "gave up after $tries attempts: $*" >&2
      return 1
    fi
    echo "the phone did not answer, retrying… ($(date +%T))"
    sleep 15
  done
}

cmd_run() {
  local plan="${1:?usage: bench.sh run <plan.json>}"
  local id poll="${BENCH_POLL_SECONDS:-20}"
  id="$(plan_id "$plan")"
  mkdir -p "$out"

  retry "${BENCH_COPY_ATTEMPTS:-480}" to_device "$plan" "Documents/bench/plan.json" || exit 1

  # The app exits when the plan is finished, on purpose between cells that ask for a clean process
  # (`restartAfter`), and when it crashes. So: poll; if the DONE marker is there, collect and stop; if
  # the app is gone without it, start it again and the plan carries on from the cell it was on.
  launch_app || exit 1
  local launches=1 gone=0 waited=0
  while true; do
    sleep "$poll"
    waited=$((waited + poll))
    pull_status "$id"

    if [ -f "$out/DONE-$id" ]; then break; fi
    if [ -f "$out/status-$id.json" ]; then
      echo "[$(date +%T)] $(tr -d '\n' <"$out/status-$id.json")"
    fi

    # Two sightings in a row, so the moment between an exit and a relaunch is not mistaken for a crash.
    if app_running; then
      gone=0
    else
      gone=$((gone + 1))
    fi
    if [ "$gone" -ge 2 ]; then
      echo "[$(date +%T)] the app is not running and the plan is not finished: starting it again"
      launch_app || exit 1
      launches=$((launches + 1))
      gone=0
    fi

    if [ "$waited" -ge "${BENCH_TIMEOUT:-21600}" ]; then
      echo "gave up after ${waited}s" >&2
      exit 1
    fi
  done

  cmd_pull "$id"
  echo "plan $id finished after $launches launch(es): $out/results-$id.jsonl"
}

case "${1:-help}" in
  build) cmd_build ;;
  install) cmd_install ;;
  models) shift; cmd_models "$@" ;;
  run) shift; cmd_run "$@" ;;
  pull) shift; cmd_pull "$@" ;;
  *) sed -n '2,16p' "${BASH_SOURCE[0]}" ;;
esac
