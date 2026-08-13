#!/usr/bin/env bash
# Build a llama-cpp-python wheel matching Dockerfile.cuda, and export it to ./dist.
#
# WHY THIS EXISTS
# Dockerfile.cuda builds llama-cpp-python from source against the JamePeng fork
# with the GGML CUDA backend, and that compile is the entire cost of a cold
# build now that flash-attn comes from a published wheel. Measured 2026-08-11 on
# a 24-core desktop: 619.6 s before the CUDA architecture list was narrowed to
# the three capabilities this appliance actually targets, 278.3 s after. Neither
# number is worth paying on every machine, on every build, for a pin that moves
# a few times a year.
#
# ccache was tried first and does not work here; Dockerfile.cuda records why at
# the llama-cpp step. The short version is that uv and scikit-build-core each
# unpack to their own fresh temp directory, so no ccache path setting can make
# the object hashes stable. This publishes the artifact instead of caching the
# inputs, which also helps CI and every other machine rather than one local
# BuildKit mount.
#
# HOW IT AVOIDS DRIFT
# Same approach as build-flash-attn-wheel.sh, and for the same reason: it does
# not reproduce Dockerfile.cuda's setup, it SPLICES the real file, taking
# everything above the compile-job-budget banner (base image, python, uv sync)
# and appending only a wheel-build step. Edit Dockerfile.cuda and this follows.
#
# Usage:
#   ./build-llama-cpp-wheel.sh            # build, verify, export to ./dist
#   PUSH=1 ./build-llama-cpp-wheel.sh     # ...and publish to GHCR
#
# WHAT THIS WHEEL IS MARRIED TO
# Three things, one fewer than flash-attn's — python, CUDA major, and the CUDA
# ARCHITECTURE LIST. Not torch: ggml does not link it. Of the three, only the
# arch list fails silently. A cp312 wheel is refused by pip on cp311, and a
# CUDA-major mismatch fails to link, but a wheel built for the wrong
# capabilities installs cleanly, imports cleanly, and then has no kernels for
# the card in front of it.
#
# So the tag below carries all three, and Dockerfile.cuda reads the arch list
# back off the shipped libggml-cuda.so with cuobjdump and refuses a wheel that
# disagrees with the image consuming it. That check is the load-bearing
# protection. The tag is documentation — accurate, but not what enforces this.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

dockerfile="backend/apps/hbpe/Dockerfile.cuda"
marker="# ── Shared compile-job budget ─"
out_dir="${OUT_DIR:-backend/apps/hbpe/dist-llama}"
gen="$(mktemp -t Dockerfile.llama.XXXXXX)"
trap 'rm -f "$gen"' EXIT

# Every pin is READ from the file that owns it, never restated here. A constant
# copied into this script is a constant that goes stale the first time the real
# one moves, and the failure is a correctly-built wheel published under a name
# that describes the previous pin.
uv_version="$(sed -n 's/^required-version = "==\(.*\)"$/\1/p' pyproject.toml)"
llama_ref="$(sed -n 's/^LLAMA_CPP_PYTHON_REF := *//p' Makefile)"
arch_list="$(sed -n 's/^ARG TORCH_CUDA_ARCH_LIST="\(.*\)"$/\1/p' "$dockerfile")"
cuda_major="$(sed -n 's|^FROM nvidia/cuda:\([0-9]*\)\..*|\1|p' "$dockerfile" | head -1)"
: "${uv_version:?could not read required-version from pyproject.toml}"
: "${llama_ref:?could not read LLAMA_CPP_PYTHON_REF from Makefile}"
: "${arch_list:?could not read ARG TORCH_CUDA_ARCH_LIST from $dockerfile}"
# No apostrophe in this message: inside "${var:?word}" a single quote opens a
# quoting context rather than being literal, and the parse error it produces
# points at a line hundreds down from the real one.
: "${cuda_major:?could not read the CUDA major from the FROM line in $dockerfile}"

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

# ── llama-cpp-python wheel build ──────────────────────────────────────────────
# The flash-attn step is deliberately absent: it binds torch, costs a compile of
# its own, and shares none of this wheel's dimensions.
ARG MAX_JOBS
ARG BUILD_RESERVE_GIB=8
ARG GIB_PER_JOB
ARG LLAMA_CPP_PYTHON_REF
ARG TORCH_CUDA_ARCH_LIST
COPY --chmod=755 backend/apps/hbpe/derive-build-jobs.sh /usr/local/bin/derive-build-jobs

# `python -m pip wheel`, not `uv pip install`, so the artifact is a file rather
# than a populated venv. Real pip rather than uv because uv has no `pip wheel`
# subcommand — checked against the pinned uv, whose `uv pip --help` lists
# compile/sync/install/uninstall/freeze/list/show/tree/check and nothing else.
# So pip is installed into the venv first, exactly as build-flash-attn-wheel.sh
# does it.
#
# Build isolation is left ON, unlike the flash-attn script. That build had to
# see the venv's torch; this one needs only scikit-build-core and ninja, which
# isolation fetches for itself, and Dockerfile.cuda's own llama-cpp step builds
# isolated too. Keeping them the same means the wheel is produced by the same
# machinery that would have produced it in-image.
#
# The job budget and the architecture derivation are identical to
# Dockerfile.cuda's llama-cpp step by construction — same script, same per-job
# figure, same `tr -d '.'` — because a wheel compiled under a different arch
# list than the image expects is exactly what the consumer-side cuobjdump check
# exists to reject, and producing one here would be a self-inflicted failure
# rather than a caught mistake.
RUN set -eu; \
    CMAKE_BUILD_PARALLEL_LEVEL="$(derive-build-jobs llama-cpp-python 2)"; \
    export CMAKE_BUILD_PARALLEL_LEVEL; \
    cuda_archs="$(echo "${TORCH_CUDA_ARCH_LIST:?set by build-llama-cpp-wheel.sh}" | tr -d '.')"; \
    echo "llama-cpp-python wheel: arch=$cuda_archs CMAKE_BUILD_PARALLEL_LEVEL=$CMAKE_BUILD_PARALLEL_LEVEL"; \
    uv pip install --no-cache pip setuptools wheel; \
    mkdir -p /tmp/wheels; \
    CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=$cuda_archs" FORCE_CMAKE=1 \
    python -m pip wheel --no-cache-dir --no-deps \
      "llama-cpp-python @ git+https://github.com/JamePeng/llama-cpp-python.git@${LLAMA_CPP_PYTHON_REF:?set by build-llama-cpp-wheel.sh}" \
      -w /tmp/wheels; \
    ls -la /tmp/wheels

# Install the wheel into the very environment it must match, then run the SAME
# two checks Dockerfile.cuda runs on the consuming side. Duplicated on purpose:
# catching a bad wheel here costs one failed build, catching it there costs a
# published image that has to be superseded, and a GHCR package cannot be
# unpushed.
#
# The stub libcuda is not optional. libggml.so links libcuda.so.1, which the
# container runtime injects at RUNTIME — without it `import llama_cpp` fails on
# every machine that has no GPU, which includes CI and includes the workstation
# this was written on.
#
# The stub is NOT cleaned up afterwards and must not be given a line to do so:
# this is a BuildKit heredoc, and the first line after the PY terminator is
# parsed as a new Dockerfile instruction, not as more shell. It costs nothing to
# leave — `verify` is a dead-end stage that is never exported or published, and
# the only stage that ships anything is `wheelout`, which is FROM scratch.
FROM builder AS verify
RUN set -eu; \
    uv pip install --no-cache /tmp/wheels/*.whl; \
    cuda_archs="$(echo "$TORCH_CUDA_ARCH_LIST" | tr -d '.')"; \
    libdir="$(dirname "$(python -c 'import importlib.util; print(importlib.util.find_spec("llama_cpp").origin)')")/lib"; \
    want="$(echo "$cuda_archs" | tr ';' '\n' | sort -u | paste -sd,)"; \
    got="$(cuobjdump "$libdir/libggml-cuda.so" | sed -n 's/.*arch = sm_\([0-9]*\).*/\1/p' | sort -u | paste -sd,)"; \
    [ -n "$got" ] || { echo "ERROR: no CUDA code images — this built CPU-only"; exit 1; }; \
    [ "$want" = "$got" ] || { echo "ERROR: built sm_[$got] but asked for sm_[$want]"; exit 1; }; \
    echo "kernels present for sm_[$got], as requested"; \
    stub="$(mktemp -d)"; \
    ln -s /usr/local/cuda/lib64/stubs/libcuda.so "$stub/libcuda.so.1"; \
    LD_LIBRARY_PATH="$stub" python - <<'PY'
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
  --build-arg "TORCH_CUDA_ARCH_LIST=$arch_list"
  --progress=plain
)

echo "==> llama-cpp-python $llama_ref, uv $uv_version, arch '$arch_list', cuda major $cuda_major"
echo "==> verifying the wheel imports and carries the right kernels before exporting it"
docker buildx build "${common[@]}" --target verify .

mkdir -p "$out_dir"
echo "==> exporting to $out_dir"
docker buildx build "${common[@]}" --target wheelout --output "type=local,dest=$out_dir" .

ls -la "$out_dir"

# ── Publish ───────────────────────────────────────────────────────────────────
# Off by default, same as the flash-attn script: builds consume this image, they
# do not produce it, and publishing is a deliberate act rather than a side
# effect of building.
registry="${WHEEL_REGISTRY:-ghcr.io/companionintelligence}"
image_name="${WHEEL_IMAGE_NAME:-companion/llama-cpp-wheel}"

# The export writes into $out_dir but does not clear it, so a wheel from an
# earlier run with a different pin survives there. Taking the first match would
# tag a public image after a wheel this run did not build, so an ambiguous
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

# Tag layout:
#
#   llama_cpp_python-0.3.46-cp311-cp311-linux_x86_64.whl
#                    └ ver ┘ └ py ┘
#
#   0.3.46-81190b03f6d1-cu12-sm86_89_120-cp311
#   └ ver ┘└ fork ref ┘ └cuda┘└─ archs ─┘└ py ┘
#
# Version and python tag are PARSED from the filename rather than composed, for
# the reason the flash-attn script gives at length: the name is what the next
# person trusts, and half-read-half-assumed is how it comes to lie. The other
# three are not in the filename at all — scikit-build-core has no equivalent of
# setup.py's local-version stamp — so they come from the same files the build
# args did, which is the closest available equivalent.
#
# The fork ref LEADS the non-version fields because it is what actually moves;
# 12 hex digits is unambiguous and keeps the tag readable. Archs use underscores
# because dots would read as another version number.
wheel_version="$(echo "$base" | cut -d- -f2)"
python_tag="$(echo "$base" | cut -d- -f3)"
arch_tag="sm$(echo "$arch_list" | tr -d '.' | tr ';' '_')"
tag="${wheel_version}-${llama_ref:0:12}-cu${cuda_major}-${arch_tag}-${python_tag}"

case "$base" in
  llama_cpp_python-*) ;;
  *) echo "ERROR: unexpected wheel name '$base' — refusing to tag from it" >&2
     exit 1 ;;
esac

# ── Publish gate ──────────────────────────────────────────────────────────────
# Identical in intent to the flash-attn script's: nothing belonging to this repo
# may leave inside the wheel. By construction nothing can — the wheel is a build
# of the JamePeng llama-cpp-python fork, and the only repo files above the
# splice point are manifests, none of which are packaged. This verifies rather
# than trusts, because the failure is one-way and unusually costly: the GHCR
# package is PUBLIC, and a pushed image cannot be unpushed.
echo "==> scanning $base for anything belonging to this repo"
command -v python3 >/dev/null || { echo "ERROR: python3 is required to scan the wheel" >&2; exit 1; }
python3 - "$wheel" <<'PY'
import re, sys, zipfile

PATTERNS = [rb"lifescope", rb"companionintelligence",
            rb"ci[-_]server", rb"ci[-_]hbpe", rb"ci[-_]telemetry"]
rx = re.compile(rb"|".join(PATTERNS), re.IGNORECASE)

# Streamed in chunks — libggml-cuda.so is >100 MB and reading members whole is
# wasteful. The overlap keeps a match straddling a chunk boundary from being
# missed; it only needs to exceed the longest pattern.
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
  echo "==> build the CUDA image against it with:"
  echo "    make build GPU=cuda LLAMA_CPP_WHEEL_IMAGE=$registry/$image_name:$tag"
else
  echo "==> not pushing (set PUSH=1 to publish). Would publish:"
  echo "    $registry/$image_name:$tag"
fi
