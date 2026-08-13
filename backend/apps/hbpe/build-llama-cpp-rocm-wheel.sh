#!/usr/bin/env bash
# Build a llama-cpp-python HIP wheel matching Dockerfile.rocm, export it to
# ./dist-llama-rocm, and optionally publish it to GHCR.
#
# WHY THIS EXISTS
# The same reason as build-llama-cpp-wheel.sh, which does this for CUDA:
# Dockerfile.rocm compiles llama-cpp-python from source with the GGML HIP
# backend, and that is the only from-source compile in the ROCm image — torch
# comes prebuilt from the rocm7.2 index, and flash-attn is absent because it has
# no ROCm build. Compiling it once and publishing the artifact removes the only
# expensive step from every appliance build and from CI.
#
# HOW IT AVOIDS DRIFT
# It does not reproduce Dockerfile.rocm's setup, it SPLICES the real file,
# taking everything above the `# ── llama-cpp-python (HIP) ─` banner (base
# image, python, uv sync, torch) and appending only a wheel-build step. Edit
# Dockerfile.rocm and this follows. The banner exists for this purpose and says
# so; if it is ever reworded this script fails loudly rather than silently
# producing a truncated Dockerfile.
#
# Usage:
#   ./build-llama-cpp-rocm-wheel.sh          # build, verify, export
#   PUSH=1 ./build-llama-cpp-rocm-wheel.sh   # ...and publish
#
# WHAT THIS WHEEL IS MARRIED TO
# Python, the ROCm major.minor, and the gfx TARGET LIST. Not torch: ggml does
# not link it. Of the three, only the target list fails quietly — a wheel built
# for the wrong gfx installs cleanly, imports cleanly, and then finds no usable
# device at runtime, which is precisely the failure Dockerfile.rocm's comment
# warns about. So the targets are read back off the shipped libggml-hip.so and
# compared, both here and on the consuming side. That comparison is the
# load-bearing protection; the tag is documentation.
#
# WHY THE TARGET LIST IS FLEET-WIDE, NOT THIS HOST'S CARD
# A source build compiles for AMDGPU_TARGETS — the card in front of it. A
# published wheel cannot: it is built once and pulled by appliances with
# different cards. So this reads AMDGPU_WHEEL_TARGETS from the Makefile, which
# holds the set Dockerfile.rocm's PRUNE_GFX_ARCHS step keeps kernels for. The
# two must agree: shipping rocBLAS kernels for a card the ggml wheel has no code
# objects for is an incoherent image.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

dockerfile="backend/apps/hbpe/Dockerfile.rocm"
marker="# ── llama-cpp-python (HIP) ─"
out_dir="${OUT_DIR:-backend/apps/hbpe/dist-llama-rocm}"
gen="$(mktemp -t Dockerfile.llamarocm.XXXXXX)"
trap 'rm -f "$gen"' EXIT

# Every pin is READ from the file that owns it, never restated here.
uv_version="$(sed -n 's/^required-version = "==\(.*\)"$/\1/p' pyproject.toml)"
llama_ref="$(sed -n 's/^LLAMA_CPP_PYTHON_REF := *//p' Makefile)"
llama_version="$(sed -n 's/^LLAMA_CPP_PYTHON_VERSION := *//p' Makefile)"
gfx_targets="${AMDGPU_WHEEL_TARGETS:-$(sed -n 's/^AMDGPU_WHEEL_TARGETS ?= *//p' Makefile)}"
rocm_version="$(sed -n 's|^FROM rocm/dev-ubuntu-22.04:\([0-9]*\.[0-9]*\).*|\1|p' "$dockerfile" | head -1)"
: "${uv_version:?could not read required-version from pyproject.toml}"
: "${llama_ref:?could not read LLAMA_CPP_PYTHON_REF from Makefile}"
: "${llama_version:?could not read LLAMA_CPP_PYTHON_VERSION from Makefile}"
: "${gfx_targets:?could not read AMDGPU_WHEEL_TARGETS from Makefile}"
: "${rocm_version:?could not read the ROCm version from the FROM line in $dockerfile}"

# Everything above the marker. Unlike the CUDA Dockerfile, this one already
# names its first stage `builder`, so there is nothing to rename — but that is
# checked rather than assumed, because the appended stages reference it by name.
grep -qF "$marker" "$dockerfile" || {
  echo "ERROR: marker not found in $dockerfile: $marker" >&2
  echo "       The file was restructured; update \$marker in this script." >&2
  exit 1
}
awk -v m="$marker" 'index($0, m) {exit} {print}' "$dockerfile" > "$gen"

grep -qE '^FROM .* AS builder' "$gen" || {
  echo "ERROR: the spliced portion of $dockerfile has no stage named 'builder'." >&2
  echo "       The appended stages below reference it by that name." >&2
  exit 1
}

cat >> "$gen" <<'DOCKERFILE'

# ── llama-cpp-python HIP wheel build ──────────────────────────────────────────
ARG MAX_JOBS
ARG BUILD_RESERVE_GIB=8
ARG GIB_PER_JOB
ARG LLAMA_CPP_PYTHON_REF
ARG AMDGPU_TARGETS
COPY --chmod=755 backend/apps/hbpe/derive-build-jobs.sh /usr/local/bin/derive-build-jobs

# The job budget is applied HERE but not in Dockerfile.rocm, which leaves
# CMAKE_BUILD_PARALLEL_LEVEL unset and lets ninja default to nproc+2. That is
# survivable for one gfx target and much less so for nine: HIP compiles each
# target separately, so an unbudgeted build multiplies concurrent compilers by
# the length of the target list. The CUDA side learned this the expensive way —
# see the job-budget notes in Dockerfile.cuda, where an unbudgeted compile
# OOM-killed the desktop and, because dockerd runs build processes at
# oom_score_adj -500, took the browser rather than the build.
#
# 2 GiB/job is llama-cpp's figure from those notes. It is the same source and
# the same class of compile; hipcc is clang where nvcc was cicc. Not
# independently measured for HIP, and deliberately the conservative direction.
#
# Real pip rather than uv: uv has no `pip wheel` subcommand.
RUN set -eu; \
    CMAKE_BUILD_PARALLEL_LEVEL="$(derive-build-jobs llama-cpp-python-hip 2)"; \
    export CMAKE_BUILD_PARALLEL_LEVEL; \
    : "${AMDGPU_TARGETS:?set by build-llama-cpp-rocm-wheel.sh — refusing to fall back to llama.cpp's default target list}"; \
    echo "llama-cpp-python HIP wheel: targets=$AMDGPU_TARGETS CMAKE_BUILD_PARALLEL_LEVEL=$CMAKE_BUILD_PARALLEL_LEVEL"; \
    uv pip install --no-cache pip setuptools wheel; \
    mkdir -p /tmp/wheels; \
    CMAKE_ARGS="-DGGML_HIP=ON -DAMDGPU_TARGETS=$AMDGPU_TARGETS" FORCE_CMAKE=1 \
    python -m pip wheel --no-cache-dir --no-deps \
      "llama-cpp-python @ git+https://github.com/JamePeng/llama-cpp-python.git@${LLAMA_CPP_PYTHON_REF:?set by build-llama-cpp-rocm-wheel.sh}" \
      -w /tmp/wheels; \
    ls -la /tmp/wheels

# Install the wheel into the very environment it must match, then run the same
# check the consuming side runs. Duplicated on purpose: catching a bad wheel
# here costs one failed build, catching it there costs a published image that
# has to be superseded, and a GHCR package cannot be unpushed.
#
# The gfx targets are read out of the embedded offload bundle triples
# (`amdgcn-amd-amdhsa--gfx1100`) with `strings` rather than roc-obj-ls, which is
# absent from the runtime image — using one method in both places means the
# consuming check cannot disagree with this one for tooling reasons.
#
# No stub library is needed, unlike the CUDA wheel: libamdhip64 loads without a
# device, so `import llama_cpp` works on a machine with no /dev/kfd at all.
# Verified on a build host with no AMD GPU visible to the container.
FROM builder AS verify
RUN set -eu; \
    uv pip install --no-cache /tmp/wheels/*.whl; \
    libdir="$(dirname "$(python -c 'import importlib.util; print(importlib.util.find_spec("llama_cpp").origin)')")/lib"; \
    so="$(ls "$libdir"/libggml-hip.so.*.* | tail -1)"; \
    want="$(echo "$AMDGPU_TARGETS" | tr ';' '\n' | sort -u | paste -sd,)"; \
    got="$(strings -a "$so" | sed -n 's/.*amdgcn-amd-amdhsa--\(gfx[0-9a-z]*\).*/\1/p' | sort -u | paste -sd,)"; \
    [ -n "$got" ] || { echo "ERROR: no gfx code objects in $so — this built CPU-only, which is what GGML_HIPBLAS=ON used to do silently"; exit 1; }; \
    [ "$want" = "$got" ] || { echo "ERROR: built for [$got] but asked for [$want]"; exit 1; }; \
    echo "code objects present for [$got], as requested"; \
    python - <<'PY'
import llama_cpp, sys
print("VERIFY_OK")
print("  llama_cpp ", llama_cpp.__version__)
print("  python     %d.%d" % sys.version_info[:2])
PY

FROM scratch AS wheelout
COPY --from=builder /tmp/wheels/ /
DOCKERFILE

common=(
  -f "$gen"
  --build-arg "UV_VERSION=$uv_version"
  --build-arg "LLAMA_CPP_PYTHON_REF=$llama_ref"
  --build-arg "AMDGPU_TARGETS=$gfx_targets"
  --progress=plain
)

echo "==> llama-cpp-python $llama_version @ $llama_ref, uv $uv_version, ROCm $rocm_version"
echo "==> gfx targets: $gfx_targets"
echo "==> verifying the wheel imports and carries the right code objects before exporting it"
docker buildx build "${common[@]}" --target verify .

mkdir -p "$out_dir"
echo "==> exporting to $out_dir"
docker buildx build "${common[@]}" --target wheelout --output "type=local,dest=$out_dir" .

ls -la "$out_dir"

# ── Publish ───────────────────────────────────────────────────────────────────
registry="${WHEEL_REGISTRY:-ghcr.io/companionintelligence}"
image_name="${WHEEL_IMAGE_NAME:-companion/llama-cpp-rocm-wheel}"

# The export writes into $out_dir but does not clear it, so a wheel from an
# earlier run with a different pin survives there. Taking the first match would
# tag a public image after a wheel this run did not build.
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

case "$base" in
  llama_cpp_python-*) ;;
  *) echo "ERROR: unexpected wheel name '$base' — refusing to tag from it" >&2
     exit 1 ;;
esac

# Tag layout:
#
#   0.3.46-81190b03f6d1-rocm7.2-gfx1030_1100_1101_1102_1103_1150_1151_1200_1201-cp311
#   └ ver ┘└ fork ref ┘ └ rocm ┘└──────────────── gfx targets ─────────────────┘└ py ┘
#
# Version and python tag are PARSED from the filename; the rest are not in it at
# all, since scikit-build-core has no equivalent of setup.py's local-version
# stamp, so they come from the same files the build args did. The gfx list is
# spelled out rather than hashed: it is the component most likely to be wrong,
# and an opaque digest would hide exactly the thing worth reading.
wheel_version="$(echo "$base" | cut -d- -f2)"
python_tag="$(echo "$base" | cut -d- -f3)"
gfx_tag="gfx$(echo "$gfx_targets" | sed 's/gfx//g' | tr ';' '_')"
tag="${wheel_version}-${llama_ref:0:12}-rocm${rocm_version}-${gfx_tag}-${python_tag}"

[ "$wheel_version" = "$llama_version" ] || {
  echo "ERROR: wheel is llama-cpp-python $wheel_version but the Makefile's" >&2
  echo "       LLAMA_CPP_PYTHON_VERSION says $llama_version. Update that pin —" >&2
  echo "       it is what composes the default tag in HBPE_GPU_BUILD_ARGS, so a" >&2
  echo "       stale value points every build at a tag that does not exist." >&2
  exit 1
}

# ── Publish gate ──────────────────────────────────────────────────────────────
# Nothing belonging to this repo may leave inside the wheel. By construction
# nothing can — it is a build of the JamePeng fork, and the only repo files
# above the splice point are manifests, none of which are packaged. This
# verifies rather than trusts: the GHCR package is PUBLIC and a pushed image
# cannot be unpushed.
echo "==> scanning $base for anything belonging to this repo"
command -v python3 >/dev/null || { echo "ERROR: python3 is required to scan the wheel" >&2; exit 1; }
python3 - "$wheel" <<'PY'
import re, sys, zipfile

PATTERNS = [rb"lifescope", rb"companionintelligence",
            rb"ci[-_]server", rb"ci[-_]hbpe", rb"ci[-_]telemetry"]
rx = re.compile(rb"|".join(PATTERNS), re.IGNORECASE)

# Streamed in chunks — a multi-target libggml-hip.so is large and reading
# members whole is wasteful. The overlap keeps a match straddling a chunk
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
  echo "==> builds pick this up automatically once LLAMA_CPP_PYTHON_VERSION and"
  echo "    AMDGPU_WHEEL_TARGETS in the Makefile match what was just published."
else
  echo "==> not pushing (set PUSH=1 to publish). Would publish:"
  echo "    $registry/$image_name:$tag"
fi
