#!/usr/bin/env bash
# Downloads the CLiteRTLM.xcframework binary the LocalLLM iOS plugin links against.
#
# Not committed to git (81MB) — SPM can't be used to fetch it directly either: Apple
# blocks an Xcode *target* from consuming a remote SPM package that declares unsafe
# linker flags, and LiteRT-LM's Swift package needs `-Xlinker -all_load`. So the plugin
# vendors the package's Swift wrapper source directly (see ../App/Vendor/LiteRTLM) and
# links this xcframework as a plain binary framework instead — which means it has to be
# fetched some other way before the App target can build.
#
# Run this once before opening the Xcode project (or building via xcodebuild):
#   frontend/apps/ios/ios/App/Frameworks/fetch-clitertlm-xcframework.sh

set -euo pipefail

VERSION="0.14.0"
URL="https://github.com/google-ai-edge/LiteRT-LM/releases/download/v${VERSION}/CLiteRTLM.xcframework.zip"
# From LiteRT-LM's Package.swift at this tag — verified against the actual download.
CHECKSUM="dddac2f6713ed65eaf01c18e115d9fec22184adf575cc7856a21387e8ba937e1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${SCRIPT_DIR}/CLiteRTLM.xcframework"

if [ -d "${DEST}" ]; then
  echo "CLiteRTLM.xcframework already present at ${DEST} — remove it first to re-fetch."
  exit 0
fi

# Download into a mktemp -d directory: appending .zip to a mktemp file writes
# to a path mktemp never created and leaves its empty file behind.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
TMP_ZIP="${TMP_DIR}/CLiteRTLM.xcframework.zip"

echo "Downloading CLiteRTLM.xcframework v${VERSION}..."
curl -fL --progress-bar -o "${TMP_ZIP}" "${URL}"

ACTUAL_CHECKSUM="$(shasum -a 256 "${TMP_ZIP}" | awk '{print $1}')"
if [ "${ACTUAL_CHECKSUM}" != "${CHECKSUM}" ]; then
  echo "error: checksum mismatch for CLiteRTLM.xcframework.zip" >&2
  echo "  expected: ${CHECKSUM}" >&2
  echo "  actual:   ${ACTUAL_CHECKSUM}" >&2
  exit 1
fi

echo "Extracting into ${SCRIPT_DIR}..."
unzip -q "${TMP_ZIP}" -d "${SCRIPT_DIR}"

echo "Done — CLiteRTLM.xcframework is ready at ${DEST}."
