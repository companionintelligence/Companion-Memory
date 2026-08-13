#!/usr/bin/env bash
# Build a flash-attn wheel matching Dockerfile.cuda, and export it to ./dist.
#
# WHY THIS EXISTS
# Dockerfile.cuda pins torch 2.13.0 on CUDA 12.9, and Dao-AILab publishes no
# flash-attn wheel for that combination — checked 2026-08-10: v2.8.3.post1 is
# the newest FA2 release and its 50 wheels span torch 2.4-2.9 only, the lone
# cu13/torch2.9 build is cp312 while this image is cp311, and everything newer
# on the releases page is an fa4-v4.0.0 beta shipping no arch wheels at all.
# So the image compiles flash-attn from source on every build (~71 min at 6
# jobs, measured). Build the wheel once with this script, host it, and pass it
# back as --build-arg FLASH_ATTN_WHEEL=<url> to skip the compile entirely.
#
# HOW IT AVOIDS DRIFT
# A wheel is married to four things — python, torch version, CUDA major, and
# torch's C++11 ABI flag — and gets them wrong silently: a mismatch installs
# cleanly and only fails at `import flash_attn_2_cuda`. So this does not
# reproduce Dockerfile.cuda's setup; it SPLICES the real file, taking everything
# above the compile-job-budget banner (base image, python, uv sync, torch) and
# appending only a wheel-build step. Edit Dockerfile.cuda and this follows.
#
# Usage:
#   ./build-flash-attn-wheel.sh
#
# The +cu12torch2.13cxx11abiTRUE local version is DERIVED inside the build from
# the image's own torch, CUDA, ABI and Python, and stamped into both the
# filename and the METADATA via FLASH_ATTN_LOCAL_VERSION. Without it a forced
# source build emits a plain flash_attn-<ver>-cp311-cp311-linux_x86_64.whl,
# because setup.py applies that tag only on its download path. Renaming the file
# afterwards does NOT work — pip compares the filename version against METADATA.
#
# Deriving it rather than passing it is the point: the tag is a claim about
# which torch/CUDA/ABI the wheel is married to, and a hand-typed one goes stale
# the first time a pin moves — bump torch and reuse last month's command and you
# stamp the old tag on a correctly-built wheel, which is worse than no tag at
# all, because the name is what the next person trusts. Setting
# FLASH_ATTN_LOCAL_VERSION explicitly still works but is checked against the
# image and fails the build if it disagrees.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

dockerfile="backend/apps/hbpe/Dockerfile.cuda"
marker="# ── Shared compile-job budget ─"
out_dir="${OUT_DIR:-backend/apps/hbpe/dist}"
gen="$(mktemp -t Dockerfile.wheel.XXXXXX)"
trap 'rm -f "$gen"' EXIT

uv_version="$(sed -n 's/^required-version = "==\(.*\)"$/\1/p' pyproject.toml)"
flash_attn_version="$(sed -n 's/^FLASH_ATTN_VERSION := *//p' Makefile)"
: "${uv_version:?could not read required-version from pyproject.toml}"
: "${flash_attn_version:?could not read FLASH_ATTN_VERSION from Makefile}"

# Everything above the marker, with the main stage named so later stages can
# reference it. Fails loudly rather than silently producing a truncated file if
# the banner is ever reworded.
grep -qF "$marker" "$dockerfile" || {
  echo "ERROR: marker not found in $dockerfile: $marker" >&2
  echo "       The file was restructured; update \$marker in this script." >&2
  exit 1
}
awk -v m="$marker" 'index($0, m) {exit} {print}' "$dockerfile" \
  | sed 's|^FROM nvidia/cuda:\(.*\)$|FROM nvidia/cuda:\1 AS builder|' > "$gen"

grep -q "AS builder" "$gen" || { echo "ERROR: failed to name the builder stage" >&2; exit 1; }

cat >> "$gen" <<'DOCKERFILE'

# ── flash-attn wheel build ────────────────────────────────────────────────────
# The llama-cpp step is deliberately absent: it binds none of the four
# dimensions above and would cost a compile of its own.
ARG MAX_JOBS
ARG BUILD_RESERVE_GIB=8
ARG GIB_PER_JOB
ARG FLASH_ATTN_VERSION
ARG FLASH_ATTN_LOCAL_VERSION=""
ARG NVCC_THREADS=1
ARG TORCH_CUDA_ARCH_LIST="8.6;8.9;12.0"
COPY --chmod=755 backend/apps/hbpe/derive-build-jobs.sh /usr/local/bin/derive-build-jobs

# FLASH_ATTENTION_FORCE_BUILD, because setup.py overrides bdist_wheel with
# CachedWheelsCommand, which urlretrieves a prebuilt wheel first and only falls
# back to source on HTTPError. That guess 404s for torch 2.13 today, so the
# fallback would fire anyway — but the point of this build is to produce the
# wheel that does not exist, and quietly repackaging someone else's binary if
# the matrix ever fills in is the wrong outcome to get by accident.
#
# Keep the PER-JOB figure identical to Dockerfile.cuda's flash-attn step (4 GiB
# per job, aggregate). See the measurement notes there before changing it: 4 is
# the higher of two measured aggregates plus ~30%, and the headroom is what
# keeps peaks that align at high concurrency from OOMing the box.
#
# The RESERVE matches Dockerfile.cuda's 8 and should be changed with it. It was
# 16 until 2026-08-11, sized to protect an interactive desktop, because
# overshooting does not fall on the build: dockerd starts build processes at
# oom_score_adj -500, so the kernel passes over every compiler and kills the
# browser instead. 8 buys two more jobs — on a 61 GiB host reporting ~49 GiB
# available, (49-8)/4 = 10 against 8 — and accepts that narrower margin on a box
# in use. Raise BOTH back toward 16 if a build ever takes a desktop down again;
# `BUILD_RESERVE_GIB=16` on the command line does it for one run without
# touching either file.
#
# THE FETCH AND THE BUILD ARE SEPARATE STEPS, and must stay that way. Asking pip
# to resolve `flash-attn==<ver>` with FLASH_ATTN_LOCAL_VERSION set cannot work:
# setup.py reports <ver>+cu12torch... , pip compares that against the `==<ver>`
# it was asked for, finds them unequal, discards the only sdist on PyPI, and
# fails with the very misleading
#
#   ERROR: No matching distribution found for flash-attn==<ver>
#
# — as though the version did not exist, while listing it among the available
# ones two lines above. So the sdist is fetched with the variable cleared, where
# the reported version still matches the pin, and the wheel is then built from
# that local path, where there is no requirement left to contradict.
#
# --no-build-isolation is needed on the DOWNLOAD too, not just the build. pip
# isolates build deps by default, and flash-attn's setup.py imports torch at
# module level, so in the overlay env it dies with `ModuleNotFoundError: No
# module named 'torch'` before it can report a version at all. Both steps have
# to run against this image's real venv, which is where torch lives.
RUN set -eu; \
    jobs="$(derive-build-jobs flash-attn 4)"; \
    : "${NVCC_THREADS:?refusing to build empty — setup.py reads this as \`getenv(...) or \"4\"\`}"; \
    supported="$(nvcc --list-gpu-arch | sed 's/compute_\(.*\)\(.\)$/\1.\2/')"; \
    kept=""; \
    for arch in $(echo "$TORCH_CUDA_ARCH_LIST" | tr ';' ' '); do \
      if echo "$supported" | grep -qx "$arch"; then kept="${kept:+$kept;}$arch"; \
      else echo "WARNING: dropping CUDA arch $arch — unsupported by this nvcc"; fi; \
    done; \
    [ -n "$kept" ] || { echo "ERROR: no requested CUDA arch supported"; exit 1; }; \
    derived="$(python -c "import torch; print('cu%storch%scxx11abi%s' % (torch.version.cuda.split('.')[0], '.'.join(torch.__version__.split('+')[0].split('.')[:2]), str(torch._C._GLIBCXX_USE_CXX11_ABI).upper()))")"; \
    if [ -z "${FLASH_ATTN_LOCAL_VERSION:-}" ]; then \
      FLASH_ATTN_LOCAL_VERSION="$derived"; \
      echo "local version derived from the image: $FLASH_ATTN_LOCAL_VERSION"; \
    elif [ "$FLASH_ATTN_LOCAL_VERSION" != "$derived" ]; then \
      echo "ERROR: --build-arg FLASH_ATTN_LOCAL_VERSION=$FLASH_ATTN_LOCAL_VERSION"; \
      echo "       but this image is  $derived"; \
      echo "       The tag names the torch/CUDA/ABI a wheel is married to. Stamping"; \
      echo "       one that disagrees with the image that built it produces a wheel"; \
      echo "       that lies about itself — worse than the untagged wheel, because"; \
      echo "       the name is what the next person will trust. Omit the variable"; \
      echo "       and it is derived correctly."; \
      exit 1; \
    fi; \
    echo "flash-attn wheel: arch=$kept MAX_JOBS=$jobs NVCC_THREADS=${NVCC_THREADS}" \
         "LOCAL_VERSION=$FLASH_ATTN_LOCAL_VERSION"; \
    export MAX_JOBS="$jobs" NVCC_THREADS="${NVCC_THREADS}" TORCH_CUDA_ARCH_LIST="$kept" \
           FLASH_ATTENTION_FORCE_BUILD=TRUE FLASH_ATTN_LOCAL_VERSION="$FLASH_ATTN_LOCAL_VERSION"; \
    uv pip install --no-cache psutil ninja pip setuptools wheel; \
    mkdir -p /tmp/wheels /tmp/src; \
    FLASH_ATTN_LOCAL_VERSION= python -m pip download --no-cache-dir --no-deps \
      --no-binary :all: --no-build-isolation \
      "flash-attn==${FLASH_ATTN_VERSION:?set by build-flash-attn-wheel.sh}" -d /tmp/src; \
    python -m pip wheel --no-cache-dir --no-build-isolation --no-deps \
      /tmp/src/flash_attn-*.tar.gz -w /tmp/wheels; \
    ls -la /tmp/wheels

# Install the wheel into the very environment it must match and import the
# COMPILED extension. flash_attn alone is not enough — the undefined-symbol
# failure lives in flash_attn_2_cuda, which is what a mismatch breaks.
FROM builder AS verify
RUN set -eu; \
    uv pip install --no-cache /tmp/wheels/*.whl; \
    python - <<'PY'
import sys, torch, flash_attn, flash_attn_2_cuda
print("VERIFY_OK")
print("  flash_attn", flash_attn.__version__)
print("  torch     ", torch.__version__)
print("  cuda      ", torch.version.cuda)
print("  cxx11abi  ", str(torch._C._GLIBCXX_USE_CXX11_ABI).upper())
print("  python     %d.%d" % sys.version_info[:2])
PY

FROM scratch AS wheelout
COPY --from=builder /tmp/wheels/ /
DOCKERFILE

common=(
  -f "$gen"
  --build-arg "UV_VERSION=$uv_version"
  --build-arg "FLASH_ATTN_VERSION=$flash_attn_version"
  --build-arg "FLASH_ATTN_LOCAL_VERSION=${FLASH_ATTN_LOCAL_VERSION:-}"
  --progress=plain
)

echo "==> flash-attn $flash_attn_version, uv $uv_version, local version '${FLASH_ATTN_LOCAL_VERSION:-<none>}'"
echo "==> verifying the wheel imports before exporting it"
docker buildx build "${common[@]}" --target verify .

mkdir -p "$out_dir"
echo "==> exporting to $out_dir"
docker buildx build "${common[@]}" --target wheelout --output "type=local,dest=$out_dir" .

ls -la "$out_dir"

# ── Publish ───────────────────────────────────────────────────────────────────
# The wheelout stage is FROM scratch carrying only the wheel, which makes it
# publishable as-is and consumable by `COPY --from` in Dockerfile.cuda — no URL,
# no token baked into a build arg, and no LFS object that pip cannot install.
# Off by default: builds consume this image, they do not produce it, and
# publishing is a deliberate act rather than a side effect of building.
registry="${WHEEL_REGISTRY:-ghcr.io/companionintelligence}"
image_name="${WHEEL_IMAGE_NAME:-companion/flash-attn-wheel}"

# The export writes into $out_dir but does not clear it, so a wheel from an
# earlier run with a different pin survives there. Taking the first match would
# then tag a public image after a wheel this run did not build, so an ambiguous
# directory is an error rather than a coin flip.
shopt -s nullglob
wheels=("$out_dir"/*.whl)
shopt -u nullglob
if [ "${#wheels[@]}" -eq 0 ]; then
  echo "ERROR: no wheel exported to $out_dir" >&2
  exit 1
elif [ "${#wheels[@]}" -gt 1 ]; then
  echo "ERROR: ${#wheels[@]} wheels in $out_dir — cannot tell which this run built:" >&2
  for w in "${wheels[@]}"; do echo "         $(basename "$w")" >&2; done
  echo "       Clear $out_dir and rerun." >&2
  exit 1
fi
wheel="${wheels[0]}"
base="$(basename "$wheel")"

# Every component of the tag is read back off the filename rather than composed
# here. The local version is derived inside the build from the image's own
# torch/CUDA/ABI, so afterwards the filename is the only place it exists, and a
# tag composed at this level could disagree with the wheel it names — the exact
# failure the derivation was added to prevent. The same reasoning covers the
# other two, so all three are parsed rather than half read and half assumed:
#
#   flash_attn-2.8.3.post1+cu12torch2.13cxx11abiTRUE-cp311-cp311-linux_x86_64.whl
#               └ version ┘ └──── local version ────┘ └ py ┘
#
# The flash-attn version LEADS the tag so that bumping FLASH_ATTN_VERSION alone,
# with the torch/CUDA/ABI pins unchanged, publishes a new tag instead of
# overwriting the one existing builds already pin to. The python tag trails
# because it is a fifth binding dimension the local version does not encode:
# cp311 and cp312 wheels are not interchangeable and neither name says so.
# Expect the local version to be LOWERCASE here — `cu12torch2.13cxx11abitrue`,
# not the `...TRUE` the build derives and logs. PEP 440 normalises local version
# segments, so that is what setup.py stamps into the filename and METADATA no
# matter what is passed in. It is deliberate that the tag follows the file
# rather than the log line: the filename is what pip and every consumer see.
# Do not "fix" the case here, and do not lowercase the derived value either —
# the guard above compares it against the env var, where the cases already agree.
case "$base" in
  *+*) ;;
  *) echo "ERROR: $base carries no +local version — the derivation did not run" >&2
     exit 1 ;;
esac
wheel_version="$(echo "$base" | cut -d- -f2)"; wheel_version="${wheel_version%%+*}"
local_version="${base#*+}"; local_version="${local_version%%-*}"
python_tag="$(echo "$base" | cut -d- -f3)"
tag="${wheel_version}-${local_version}-${python_tag}"

# Cross-check against the pin the build was told to use. These can only diverge
# if $out_dir held something this run did not produce, which the count check
# above should already have caught — belt and braces, because the cost of being
# wrong is a mislabelled public image.
[ "$wheel_version" = "$flash_attn_version" ] || {
  echo "ERROR: wheel is flash-attn $wheel_version but the Makefile pins $flash_attn_version" >&2
  echo "       Stale artifact in $out_dir, or the pin moved mid-run. Clear it and rerun." >&2
  exit 1
}

# ── Publish gate ──────────────────────────────────────────────────────────────
# Nothing belonging to this repo may leave inside the wheel. By construction
# nothing can: the wheel is pip's build of flash-attn from PyPI, and the only
# repo files above the splice point are five manifests, none of which are
# packaged. This verifies that rather than trusting it, because the failure is
# one-way and unusually costly here: the GHCR package is PUBLIC, and a pushed
# image cannot be unpushed — mirrors and caches outlive a delete.
#
# Members are read out of the zip rather than grepped in place: a wheel is a
# deflate-compressed archive, so member contents are not plain text inside the
# file and scanning the archive itself would find nothing and look clean.
echo "==> scanning $base for anything belonging to this repo"
command -v python3 >/dev/null || { echo "ERROR: python3 is required to scan the wheel" >&2; exit 1; }
python3 - "$wheel" <<'PY'
import re, sys, zipfile

# Names identifying this repo, the org, or its packages. Matched
# case-insensitively against both member paths and member contents.
PATTERNS = [rb"lifescope", rb"companionintelligence",
            rb"ci[-_]server", rb"ci[-_]hbpe", rb"ci[-_]telemetry"]
rx = re.compile(rb"|".join(PATTERNS), re.IGNORECASE)

# Streamed in chunks — the compiled extension is large enough that reading
# members whole is wasteful. The overlap keeps a match that straddles a chunk
# boundary from being missed; it only needs to exceed the longest pattern.
CHUNK, OVERLAP = 8 << 20, 64

def scan(fh):
    found, tail = set(), b""
    while True:
        buf = fh.read(CHUNK)
        if not buf:
            return found
        found.update(m.group(0) for m in rx.finditer(tail + buf))
        tail = buf[-OVERLAP:]

hits = []
with zipfile.ZipFile(sys.argv[1]) as z:
    names = z.namelist()
    for name in names:
        if rx.search(name.encode()):
            hits.append((name, "in the member path"))
        with z.open(name) as fh:
            hits += [(name, m.decode("utf-8", "replace")) for m in sorted(scan(fh))]

# flush=True so the listing precedes any error below; stdout is block-buffered
# when piped into a log, stderr is not, and the two would otherwise interleave
# backwards at exactly the moment someone is reading to find out what leaked.
print("    top-level members: " + ", ".join(sorted({n.split("/")[0] for n in names})),
      flush=True)

if hits:
    print("\nERROR: the wheel carries names belonging to this repo:", file=sys.stderr)
    for name, what in hits:
        print("    %s: %s" % (name, what), file=sys.stderr)
    print("\nRefusing to publish. The GHCR package is public and a pushed image"
          "\ncannot be unpushed — investigate before overriding.", file=sys.stderr)
    raise SystemExit(1)

print("    clean: no repo, org, or package names in any member")
PY

if [ "${PUSH:-0}" = 1 ]; then
  echo "==> pushing $registry/$image_name:$tag"
  docker buildx build "${common[@]}" --target wheelout \
    --tag "$registry/$image_name:$tag" --push .
  echo
  echo "==> build the CUDA image against it with:"
  echo "    make build GPU=cuda FLASH_ATTN_WHEEL_IMAGE=$registry/$image_name:$tag"
else
  echo "==> not pushing (set PUSH=1 to publish). Would publish:"
  echo "    $registry/$image_name:$tag"
fi
