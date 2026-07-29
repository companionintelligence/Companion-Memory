#!/usr/bin/env bash
set -euo pipefail

# ── HBPE GPU Detection ──────────────────────────────────────────────────
#
# Picks which HBPE Dockerfile variant (backend/apps/hbpe/Dockerfile.*)
# matches the GPU actually present on this host, so `make build`/`dev`/
# `staging`/`production` do not require the caller to already know their
# own hardware. Mirrors the probes CI-Hub's hardware-inspector.service.ts
# (detectRocmSupport / nvidia-smi detection) uses to classify a host, scoped
# down to a single vendor decision instead of a full hardware profile.
#
# Detection order (first match wins):
#   1. nvidia — `nvidia-smi` on PATH, or /dev/nvidia* device nodes present.
#   2. amd    — /dev/kfd + /dev/dri present (ROCm KFD driver passthrough),
#               or `rocminfo` on PATH.
#   3. cpu    — neither found.
#
# Prints exactly one of: cuda | rocm | cpu
#
# Usage:
#   scripts/detect-gpu.sh
#   GPU="$(scripts/detect-gpu.sh)"
#
# Consumed by the Makefile's `GPU ?= $(shell scripts/detect-gpu.sh)` default,
# which only runs this when the caller hasn't already passed GPU=cpu|cuda|rocm
# on the command line or environment.

has_nvidia_gpu() {
  command -v nvidia-smi >/dev/null 2>&1 && return 0
  ls /dev/nvidia* >/dev/null 2>&1 && return 0
  return 1
}

has_rocm_gpu() {
  { [ -e /dev/kfd ] && [ -e /dev/dri ]; } && return 0
  command -v rocminfo >/dev/null 2>&1 && return 0
  return 1
}

if has_nvidia_gpu; then
  echo cuda
elif has_rocm_gpu; then
  echo rocm
else
  echo cpu
fi
