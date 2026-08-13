#!/bin/sh
# Prints the number of compile jobs this machine can afford, on stdout.
#
# Shared by every from-source CUDA compile in Dockerfile.cuda — flash-attn via
# MAX_JOBS, llama-cpp-python via CMAKE_BUILD_PARALLEL_LEVEL. It lives in its own
# file rather than inline in each RUN so the two cannot drift apart: they are
# spending from one budget, and a machine that can afford N of one compiler can
# afford N of the other.
#
# Reasoning goes to stderr, the number alone to stdout, so callers can do
#   jobs="$(derive-build-jobs flash-attn)"
# and still have the derivation show up under `docker build --progress=plain`.
#
# Usage: derive-build-jobs <label> [gib_per_job]
#
# The per-job cost is an ARGUMENT, not a shared constant, because it is a
# property of the compile and not of the machine — the two callers differ by
# more than an order of magnitude (see Dockerfile.cuda, where each passes its
# own measured figure). The reserve is shared: there is only one desktop to
# stay out of the way of.
#
# Tuning knobs, read from the environment (Dockerfile.cuda declares them as
# build args, so `--build-arg` sets them):
#
#   MAX_JOBS          skip the derivation, use this
#   BUILD_RESERVE_GIB memory to leave for everything that is not this build
#   GIB_PER_JOB       override the caller's per-job figure, for every step
set -eu

label="${1:-build}"
reserve="${BUILD_RESERVE_GIB:-8}"
per_job="${GIB_PER_JOB:-${2:-8}}"

if [ -n "${MAX_JOBS:-}" ]; then
  echo "$label parallelism from build arg: $MAX_JOBS jobs" >&2
  echo "$MAX_JOBS"
  exit 0
fi

# Guard the divisor rather than let $(( )) abort with a bare "division by zero"
# from inside a RUN, where it is a long way from the --build-arg that caused it.
if [ "$per_job" -lt 1 ]; then
  echo "GIB_PER_JOB must be at least 1, got '$per_job'" >&2
  exit 1
fi

cores="$(nproc)"

# MemAvailable, not MemFree: page cache is reclaimable and counting it as
# unavailable would under-subscribe a box that has merely been running a while.
mem_gib="$(awk '/MemAvailable/ {printf "%d", $2 / 1024 / 1024}' /proc/meminfo)"

# Bounded by BOTH limits, because they bind on different hardware: cores on a
# small VM, memory on a many-core box.
by_mem="$(( (mem_gib - reserve) / per_job ))"
if [ "$by_mem" -lt 1 ]; then by_mem=1; fi
if [ "$cores" -lt "$by_mem" ]; then jobs="$cores"; else jobs="$by_mem"; fi

echo "$label parallelism derived: ${cores} cores, ${mem_gib} GiB available" >&2
echo "  - ${reserve} GiB reserved, ${per_job} GiB/job -> ${jobs} jobs" >&2
echo "$jobs"
