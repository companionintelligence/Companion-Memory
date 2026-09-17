/**
 * gpu — GPU auto-detection and the HBPE image's GPU-variant build-arg/tag
 * logic, ported from the pre-port Makefile.
 *
 * Four values below (FLASH_ATTN_VERSION, LLAMA_CPP_PYTHON_REF,
 * LLAMA_CPP_PYTHON_VERSION, AMDGPU_WHEEL_TARGETS's default) are NOT
 * recomputed here from scratch — they are read back out of the Makefile's
 * own text, the same way `backend/apps/hbpe/build-{flash-attn,llama-cpp,
 * llama-cpp-rocm}-wheel.sh` already `sed` them out by name to publish
 * prebuilt wheels. Those three scripts are outside this port's scope, so
 * the four `NAME := value` / `NAME ?= value` lines stay in the Makefile,
 * byte-identical, as the one shared source of truth for all four
 * consumers — duplicating the literals here instead would create a second
 * copy that silently drifts the next time someone bumps a pin.
 */
import fs from 'node:fs';
import path from 'node:path';

import { tryRun } from './exec';

export type Gpu = 'cpu' | 'cuda' | 'rocm';

export const VALID_GPUS: Gpu[] = ['cpu', 'cuda', 'rocm'];

/** `scripts/detect-gpu.sh`'s own vendor probe — unchanged, still a bash
 * script, so `dev`/`build`'s host-hardware detection cannot drift from
 * whatever else on the box shells out to it. */
export function detectGpu(root: string): Gpu {
  const out = tryRun('scripts/detect-gpu.sh', [], { cwd: root }).stdout.trim();

  return (VALID_GPUS as string[]).includes(out) ? (out as Gpu) : 'cpu';
}

/** This host's AMD gfx architecture (e.g. `gfx1100`), or `''` when it can't
 * be determined — an empty answer is deliberate (the pre-port Makefile's
 * comment), not a failure. */
export function detectAmdgpuArch(root: string): string {
  return tryRun('scripts/detect-gpu.sh', ['--amdgpu-arch'], { cwd: root }).stdout.trim();
}

// ── The 4 pins read by name from the Makefile's own text ────────────────────

export function readMakefile(root: string): string {
  return fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
}

/**
 * Pure: reads a `NAME := value` / `NAME ?= value` line out of the Makefile's
 * text. `operator` is `:=` for a plain pin, `?=` for one with a default.
 *
 * Whitespace around the operator is matched loosely (`\s*`), NOT as the single
 * literal space the sibling wheel-publish scripts' seds require. Make treats
 * `NAME := v`, `NAME  := v` and `NAME\t:= v` as identical, and the pins sit
 * next to column-aligned neighbours — so a whitespace-only realignment must not
 * change what this reads. The strict form silently returned '' for exactly that
 * edit, which would have composed an image tag with a hole in it
 * (`flash-attn-wheel:-cu12torch...`) on the path `make publish` builds every
 * released image from. Callers must still guard for '' — see readPinOrThrow.
 */
function readPin(makefileText: string, name: string, operator: ':=' | '?='): string {
  const escapedOp = operator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = makefileText.match(new RegExp(`^${name}\\s*${escapedOp}\\s*(.*)$`, 'm'));

  return (match?.[1] ?? '').trim();
}

/**
 * A pin that has no meaningful empty value. Mirrors the `:?` guards the
 * wheel-publish scripts already apply to the same four lines (e.g.
 * build-flash-attn-wheel.sh's
 * `: "${flash_attn_version:?could not read FLASH_ATTN_VERSION from Makefile}"`),
 * so a pin this file can no longer find fails loudly here instead of being
 * interpolated into a build arg as an empty string.
 */
function readPinOrThrow(makefileText: string, name: string, operator: ':=' | '?='): string {
  const value = readPin(makefileText, name, operator);

  if (!value) {
    throw new Error(`could not read ${name} from the Makefile`);
  }

  return value;
}

export const readFlashAttnVersionPin = (makefileText: string): string =>
  readPinOrThrow(makefileText, 'FLASH_ATTN_VERSION', ':=');
export const readLlamaCppPythonRefPin = (makefileText: string): string =>
  readPinOrThrow(makefileText, 'LLAMA_CPP_PYTHON_REF', ':=');
export const readLlamaCppPythonVersionPin = (makefileText: string): string =>
  readPinOrThrow(makefileText, 'LLAMA_CPP_PYTHON_VERSION', ':=');
export const readAmdgpuWheelTargetsDefaultPin = (makefileText: string): string =>
  readPinOrThrow(makefileText, 'AMDGPU_WHEEL_TARGETS', '?=');

// ── Values derived from the HBPE Dockerfiles ───────────────────────────────

export interface HbpeCudaMeta {
  torchVersion: string;
  cudaMajor: string;
  cudaArchs: string;
  pyVersion: string;
}

/** Pure: mirrors the four `sed -n '...' | head -1` reads of Dockerfile.cuda
 * the pre-port `build` target did. */
export function parseHbpeCudaMeta(dockerfileCuda: string): HbpeCudaMeta {
  return {
    torchVersion: dockerfileCuda.match(/^ *torch==([0-9.]*).*/m)?.[1] ?? '',
    cudaMajor: dockerfileCuda.match(/^FROM nvidia\/cuda:([0-9]*)\..*/m)?.[1] ?? '',
    cudaArchs: dockerfileCuda.match(/^ARG TORCH_CUDA_ARCH_LIST="(.*)"$/m)?.[1] ?? '',
    pyVersion: dockerfileCuda.match(/^RUN uv python install ([0-9.]*) *$/m)?.[1] ?? '',
  };
}

export interface HbpeRocmMeta {
  rocmVersion: string;
  pyVersion: string;
}

/** Pure: mirrors the two `sed -n '...' | head -1` reads of Dockerfile.rocm
 * the pre-port `build` target did. */
export function parseHbpeRocmMeta(dockerfileRocm: string): HbpeRocmMeta {
  return {
    rocmVersion: dockerfileRocm.match(/^FROM rocm\/dev-ubuntu-22\.04:([0-9]*\.[0-9]*).*/m)?.[1] ?? '',
    pyVersion: dockerfileRocm.match(/^RUN uv python install ([0-9.]*) *$/m)?.[1] ?? '',
  };
}

/** `cp` + version with the dots stripped: "3.11" -> "cp311". */
export const pyTag = (pyVersion: string): string => `cp${pyVersion.replace(/\./g, '')}`;

/**
 * GNU Make's `$(basename ...)` strips the LAST dot-segment of a string
 * ("2.13.0" -> "2.13") — this has nothing to do with Node's `path.basename`,
 * which strips a directory prefix and only touches an extension when one is
 * passed explicitly. the pre-port Makefile put it: "torch's local-version segment
 * is MAJOR.MINOR — basename drops the patch."
 */
export function makeBasenameStyle(version: string): string {
  const parts = version.split('.');

  return parts.length > 1 ? parts.slice(0, -1).join('.') : version;
}

/** "8.6;8.9;12.0" -> "sm86_89_120" (dots dropped, then `;` -> `_`). */
export const archTag = (cudaArchs: string): string => `sm${cudaArchs.replace(/\./g, '').replace(/;/g, '_')}`;

/** "gfx1030;gfx1100" -> "gfx1030_1100" ("gfx" dropped, then `;` -> `_`). */
export const gfxTag = (amdgpuWheelTargets: string): string =>
  `gfx${amdgpuWheelTargets.replace(/gfx/g, '').replace(/;/g, '_')}`;

// ── Wheel-image tag composition ────────────────────────────────────────────

export function flashAttnWheelImageDefault(meta: HbpeCudaMeta, flashAttnVersion: string): string {
  const torchMinor = makeBasenameStyle(meta.torchVersion);

  return `ghcr.io/companionintelligence/companion/flash-attn-wheel:${flashAttnVersion}-cu${meta.cudaMajor}torch${torchMinor}cxx11abitrue-${pyTag(meta.pyVersion)}`;
}

export function llamaCppWheelImageDefault(
  meta: HbpeCudaMeta,
  llamaCppVersion: string,
  llamaCppRef: string,
): string {
  return `ghcr.io/companionintelligence/companion/llama-cpp-wheel:${llamaCppVersion}-${llamaCppRef.slice(0, 12)}-cu${meta.cudaMajor}-${archTag(meta.cudaArchs)}-${pyTag(meta.pyVersion)}`;
}

export function llamaCppRocmWheelImageDefault(
  meta: HbpeRocmMeta,
  llamaCppVersion: string,
  llamaCppRef: string,
  amdgpuWheelTargets: string,
): string {
  return `ghcr.io/companionintelligence/companion/llama-cpp-rocm-wheel:${llamaCppVersion}-${llamaCppRef.slice(0, 12)}-rocm${meta.rocmVersion}-${gfxTag(amdgpuWheelTargets)}-${pyTag(meta.pyVersion)}`;
}

// ── Tying it together: the HBPE build's Dockerfile + build-arg set ──────────

export interface HbpeBuildConfig {
  dockerfile: string; // relative to backend/apps/hbpe/
  buildArgs: string[]; // flat ["--build-arg", "KEY=VAL", ...] pairs
  warning: string | null;
  /** This host's detected gfx target, for the "(rocm gfx1100)" /
   * "(rocm no-gfx-target)" build-header label — empty outside gpu==='rocm'. */
  amdgpuTargets: string;
}

/**
 * Computes the HBPE image's Dockerfile variant and full `--build-arg` list
 * for one GPU flavor, including the 5 documented escape hatches
 * (AMDGPU_TARGETS, FLASH_ATTN_WHEEL, FLASH_ATTN_WHEEL_IMAGE,
 * LLAMA_CPP_WHEEL_IMAGE, LLAMA_CPP_ROCM_WHEEL_IMAGE — the pre-port Makefile's
 * `make build GPU=cuda FLASH_ATTN_WHEEL_IMAGE=` pattern), read straight off
 * `process.env` with `??`: unset means "compute the default", an explicit
 * empty string means "the operator asked for the source compile, honor it".
 * This needs no Makefile declaration for any of the 5 — GNU Make exports any
 * command-line-provided `VAR=value` to the recipe's shell even when the
 * Makefile itself never mentions that variable.
 *
 * The same `process.env.X ?? <pin>` treatment is applied to the three pins the
 * Makefile still declares (FLASH_ATTN_VERSION, LLAMA_CPP_PYTHON_REF,
 * LLAMA_CPP_PYTHON_VERSION), so `make build LLAMA_CPP_PYTHON_REF=<sha>` keeps
 * working — a command-line assignment overrode a `:=` in Make, and dropping the
 * env read silently ignored it. ONE deliberate difference from Make: a `:=`
 * also beat an AMBIENT environment variable, and from here the two are
 * indistinguishable, so an exported LLAMA_CPP_PYTHON_REF now wins where it
 * previously lost. Uniform across all three rather than half-and-half.
 *
 * Throws when a Dockerfile pin or a Makefile pin can't be read, matching both
 * the `$(error ...)` guards the `build` target used and the `:?` guards the
 * wheel-publish scripts apply to the same Makefile lines.
 */
export function computeHbpeBuildConfig(root: string, gpu: Gpu, uvVersion: string): HbpeBuildConfig {
  const makefileText = readMakefile(root);
  const llamaCppRef = process.env.LLAMA_CPP_PYTHON_REF ?? readLlamaCppPythonRefPin(makefileText);
  const llamaCppVersion = process.env.LLAMA_CPP_PYTHON_VERSION ?? readLlamaCppPythonVersionPin(makefileText);

  const buildArgs = [
    '--build-arg',
    `UV_VERSION=${uvVersion}`,
    '--build-arg',
    `LLAMA_CPP_PYTHON_REF=${llamaCppRef}`,
  ];
  let warning: string | null = null;

  if (gpu === 'rocm') {
    const dockerfileRocm = fs.readFileSync(path.join(root, 'backend/apps/hbpe/Dockerfile.rocm'), 'utf8');
    const meta = parseHbpeRocmMeta(dockerfileRocm);

    if (!meta.rocmVersion) {
      throw new Error(
        'could not read the ROCm version from the FROM line in backend/apps/hbpe/Dockerfile.rocm',
      );
    }

    if (!meta.pyVersion) {
      throw new Error('could not read the python version from backend/apps/hbpe/Dockerfile.rocm');
    }

    const amdgpuTargets = process.env.AMDGPU_TARGETS ?? detectAmdgpuArch(root);
    const amdgpuWheelTargets =
      process.env.AMDGPU_WHEEL_TARGETS ?? readAmdgpuWheelTargetsDefaultPin(makefileText);

    if (!amdgpuWheelTargets) {
      throw new Error('AMDGPU_WHEEL_TARGETS is empty — a published wheel needs an explicit gfx target list');
    }

    const llamaCppRocmWheelImage =
      process.env.LLAMA_CPP_ROCM_WHEEL_IMAGE ??
      llamaCppRocmWheelImageDefault(meta, llamaCppVersion, llamaCppRef, amdgpuWheelTargets);

    buildArgs.push('--build-arg', `AMDGPU_TARGETS=${amdgpuTargets}`);

    if (llamaCppRocmWheelImage) {
      buildArgs.push('--build-arg', `LLAMA_CPP_ROCM_WHEEL_IMAGE=${llamaCppRocmWheelImage}`);
    }

    if (!amdgpuTargets) {
      warning =
        "No AMD gfx architecture detected — llama.cpp will build for its default\n  target list, which may not include this host's card. Pass AMDGPU_TARGETS=gfx####\n  to compile for it explicitly (rocminfo | grep gfx reports it).";
    }

    return { dockerfile: 'Dockerfile.rocm', buildArgs, warning, amdgpuTargets };
  }

  if (gpu === 'cuda') {
    const dockerfileCuda = fs.readFileSync(path.join(root, 'backend/apps/hbpe/Dockerfile.cuda'), 'utf8');
    const meta = parseHbpeCudaMeta(dockerfileCuda);

    if (!meta.torchVersion) {
      throw new Error('could not read the torch pin from backend/apps/hbpe/Dockerfile.cuda');
    }

    if (!meta.cudaMajor) {
      throw new Error(
        'could not read the CUDA major from the FROM line in backend/apps/hbpe/Dockerfile.cuda',
      );
    }

    if (!meta.cudaArchs) {
      throw new Error('could not read ARG TORCH_CUDA_ARCH_LIST from backend/apps/hbpe/Dockerfile.cuda');
    }

    if (!meta.pyVersion) {
      throw new Error('could not read the python version from backend/apps/hbpe/Dockerfile.cuda');
    }

    const flashAttnVersion = process.env.FLASH_ATTN_VERSION ?? readFlashAttnVersionPin(makefileText);
    const flashAttnWheel = process.env.FLASH_ATTN_WHEEL ?? '';
    const flashAttnWheelImage =
      process.env.FLASH_ATTN_WHEEL_IMAGE ?? flashAttnWheelImageDefault(meta, flashAttnVersion);
    const llamaCppWheelImage =
      process.env.LLAMA_CPP_WHEEL_IMAGE ?? llamaCppWheelImageDefault(meta, llamaCppVersion, llamaCppRef);

    buildArgs.push('--build-arg', `FLASH_ATTN_VERSION=${flashAttnVersion}`);

    if (flashAttnWheel) {
      buildArgs.push('--build-arg', `FLASH_ATTN_WHEEL=${flashAttnWheel}`);
    }

    if (flashAttnWheelImage) {
      buildArgs.push('--build-arg', `FLASH_ATTN_WHEEL_IMAGE=${flashAttnWheelImage}`);
    }

    if (llamaCppWheelImage) {
      buildArgs.push('--build-arg', `LLAMA_CPP_WHEEL_IMAGE=${llamaCppWheelImage}`);
    }

    return { dockerfile: 'Dockerfile.cuda', buildArgs, warning, amdgpuTargets: '' };
  }

  return { dockerfile: 'Dockerfile', buildArgs, warning, amdgpuTargets: '' };
}
