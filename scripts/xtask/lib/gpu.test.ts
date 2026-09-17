import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  archTag,
  flashAttnWheelImageDefault,
  gfxTag,
  llamaCppRocmWheelImageDefault,
  llamaCppWheelImageDefault,
  makeBasenameStyle,
  parseHbpeCudaMeta,
  parseHbpeRocmMeta,
  pyTag,
  readAmdgpuWheelTargetsDefaultPin,
  readFlashAttnVersionPin,
  readLlamaCppPythonRefPin,
  readLlamaCppPythonVersionPin,
} from './gpu';

// Fixture text mirrors the real backend/apps/hbpe/Dockerfile.cuda's shape —
// see the file itself for why each line looks the way it does.
const DOCKERFILE_CUDA = `
FROM ghcr.io/astral-sh/uv:\${UV_VERSION} AS uv
FROM nvidia/cuda:12.9.2-cudnn-devel-ubuntu22.04
RUN uv python install 3.11
ARG TORCH_CUDA_ARCH_LIST="8.6;8.9;12.0"
RUN uv pip install --no-cache \\
    torch==2.13.0 torchvision \\
    --index-url https://download.pytorch.org/whl/cu129
`;

const DOCKERFILE_ROCM = `
FROM \${LLAMA_CPP_ROCM_WHEEL_IMAGE:-scratch} AS llama-cpp-rocm-wheel
FROM rocm/dev-ubuntu-22.04:7.2.4-complete AS builder
RUN uv python install 3.11
FROM rocm/dev-ubuntu-22.04:7.2.4
`;

const MAKEFILE_FIXTURE = `
FLASH_ATTN_VERSION := 2.8.3.post1
LLAMA_CPP_PYTHON_REF := 81190b03f6d177988112dad5fc919491a77705d1
LLAMA_CPP_PYTHON_VERSION := 0.3.46
AMDGPU_WHEEL_TARGETS ?= gfx1030;gfx1100;gfx1101;gfx1102;gfx1103;gfx1150;gfx1151;gfx1200;gfx1201
`;

test('parseHbpeCudaMeta reads all four fields off Dockerfile.cuda-shaped text', () => {
  assert.deepEqual(parseHbpeCudaMeta(DOCKERFILE_CUDA), {
    torchVersion: '2.13.0',
    cudaMajor: '12',
    cudaArchs: '8.6;8.9;12.0',
    pyVersion: '3.11',
  });
});

test('parseHbpeRocmMeta reads both fields off Dockerfile.rocm-shaped text, taking the builder FROM not the runtime one', () => {
  assert.deepEqual(parseHbpeRocmMeta(DOCKERFILE_ROCM), { rocmVersion: '7.2', pyVersion: '3.11' });
});

test('the 4 wheel-publish pins are read from the Makefile text by exact name', () => {
  assert.equal(readFlashAttnVersionPin(MAKEFILE_FIXTURE), '2.8.3.post1');
  assert.equal(readLlamaCppPythonRefPin(MAKEFILE_FIXTURE), '81190b03f6d177988112dad5fc919491a77705d1');
  assert.equal(readLlamaCppPythonVersionPin(MAKEFILE_FIXTURE), '0.3.46');
  assert.equal(
    readAmdgpuWheelTargetsDefaultPin(MAKEFILE_FIXTURE),
    'gfx1030;gfx1100;gfx1101;gfx1102;gfx1103;gfx1150;gfx1151;gfx1200;gfx1201',
  );
});

test('a pin survives whitespace realignment — Make treats these as identical, so this must too', () => {
  // The pins sit next to column-aligned neighbours, so aligning them is a
  // plausible edit. The original strict `NAME := ` regex returned '' for every
  // form below except the first, silently composing an image tag with a hole
  // in it on the path `make publish` builds released images from.
  for (const line of [
    'FLASH_ATTN_VERSION := 2.8.3.post1',
    'FLASH_ATTN_VERSION  := 2.8.3.post1',
    'FLASH_ATTN_VERSION\t:= 2.8.3.post1',
    'FLASH_ATTN_VERSION :=  2.8.3.post1',
  ]) {
    assert.equal(readFlashAttnVersionPin(line), '2.8.3.post1', `failed for: ${JSON.stringify(line)}`);
  }
});

test('a pin that cannot be read throws instead of yielding an empty build arg', () => {
  assert.throws(
    () => readFlashAttnVersionPin('# FLASH_ATTN_VERSION was renamed\nSOMETHING_ELSE := 1.0\n'),
    /could not read FLASH_ATTN_VERSION from the Makefile/,
  );
  assert.throws(() => readLlamaCppPythonRefPin('nothing here'), /could not read LLAMA_CPP_PYTHON_REF/);
});

test('pyTag strips the dot: "3.11" -> "cp311"', () => {
  assert.equal(pyTag('3.11'), 'cp311');
});

test('makeBasenameStyle mirrors GNU Make basename, not Node path.basename: drops only the last dot-segment', () => {
  assert.equal(makeBasenameStyle('2.13.0'), '2.13');
  assert.equal(makeBasenameStyle('2.13'), '2');
});

test('archTag drops dots then joins with underscores, prefixed sm', () => {
  assert.equal(archTag('8.6;8.9;12.0'), 'sm86_89_120');
});

test('gfxTag drops the "gfx" substrings then joins with underscores, re-prefixed', () => {
  assert.equal(gfxTag('gfx1030;gfx1100'), 'gfx1030_1100');
});

test('flashAttnWheelImageDefault composes the documented tag shape', () => {
  const meta = parseHbpeCudaMeta(DOCKERFILE_CUDA);

  assert.equal(
    flashAttnWheelImageDefault(meta, '2.8.3.post1'),
    'ghcr.io/companionintelligence/companion/flash-attn-wheel:2.8.3.post1-cu12torch2.13cxx11abitrue-cp311',
  );
});

test('llamaCppWheelImageDefault composes the documented tag shape', () => {
  const meta = parseHbpeCudaMeta(DOCKERFILE_CUDA);

  assert.equal(
    llamaCppWheelImageDefault(meta, '0.3.46', '81190b03f6d177988112dad5fc919491a77705d1'),
    'ghcr.io/companionintelligence/companion/llama-cpp-wheel:0.3.46-81190b03f6d1-cu12-sm86_89_120-cp311',
  );
});

test('llamaCppRocmWheelImageDefault composes the documented tag shape', () => {
  const meta = parseHbpeRocmMeta(DOCKERFILE_ROCM);

  assert.equal(
    llamaCppRocmWheelImageDefault(
      meta,
      '0.3.46',
      '81190b03f6d177988112dad5fc919491a77705d1',
      'gfx1030;gfx1100',
    ),
    'ghcr.io/companionintelligence/companion/llama-cpp-rocm-wheel:0.3.46-81190b03f6d1-rocm7.2-gfx1030_1100-cp311',
  );
});
