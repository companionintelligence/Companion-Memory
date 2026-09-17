/**
 * Live GPU memory counters, for the residency planner's headroom.
 *
 * Ollama's `/api/ps` only knows what Ollama loaded. HBPE holds the GPU through
 * `/dev/kfd` directly and the desktop compositor holds a little more, so the
 * planner reads the DEVICE's counters where it can and falls back to a
 * configured total plus Ollama's own residents where it cannot.
 *
 * Ladder, first hit wins:
 *
 *   1. AMD sysfs — `/sys/class/drm/card<N>/device/mem_info_vram_{used,total}`.
 *      Readable from inside a container too (Docker mounts sysfs). The card
 *      with the LARGEST total wins: on this machine `card0` is a 512 MiB iGPU.
 *   2. `nvidia-smi --query-gpu=memory.used,memory.total`. Present in a
 *      container only under the NVIDIA runtime; a missing binary is a normal
 *      miss, not an error.
 *   3. `LLM_RESIDENCY_VRAM_TOTAL_BYTES` (config) as the total, with the sum of
 *      Ollama's residents as "used". Blind to HBPE — the safety margin is the
 *      only thing covering it on this rung — but better than refusing to plan.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GpuMemory } from './footprint';

const NVIDIA_SMI_TIMEOUT_MS = 2_000;

async function readInteger(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    const value = Number.parseInt(raw, 10);

    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Rung 1. `root` is a parameter so a test can point it at a fixture tree. */
export async function readSysfsGpuMemory(root = '/sys/class/drm'): Promise<GpuMemory | null> {
  let entries: string[];

  try {
    entries = await readdir(root);
  } catch {
    return null;
  }

  let best: GpuMemory | null = null;

  for (const entry of entries) {
    // `card1` yes; `card1-DP-1` (a connector) no.
    if (!/^card\d+$/.test(entry)) {
      continue;
    }

    const device = join(root, entry, 'device');
    const totalBytes = await readInteger(join(device, 'mem_info_vram_total'));

    if (totalBytes == null || totalBytes <= 0) {
      continue;
    }

    const usedBytes = await readInteger(join(device, 'mem_info_vram_used'));

    if (usedBytes == null) {
      continue;
    }

    if (best == null || totalBytes > best.totalBytes) {
      best = { totalBytes, usedBytes, source: 'sysfs', device: entry };
    }
  }

  return best;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;

const defaultExecFile: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout });
      }
    });
  });

/** Rung 2. Parses `used, total` in MiB, one GPU per line; the largest total wins. */
export async function readNvidiaSmiGpuMemory(
  exec: ExecFileLike = defaultExecFile,
): Promise<GpuMemory | null> {
  let stdout: string;

  try {
    ({ stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: NVIDIA_SMI_TIMEOUT_MS },
    ));
  } catch {
    return null;
  }

  let best: GpuMemory | null = null;

  for (const line of stdout.split('\n')) {
    const parts = line.split(',').map((part) => part.trim());

    if (parts.length < 3) {
      continue;
    }

    const [name, usedMiB, totalMiB] = [parts[0], Number(parts[1]), Number(parts[2])];

    if (!Number.isFinite(usedMiB) || !Number.isFinite(totalMiB) || totalMiB <= 0) {
      continue;
    }

    const reading: GpuMemory = {
      totalBytes: Math.round(totalMiB * 1024 * 1024),
      usedBytes: Math.round(usedMiB * 1024 * 1024),
      source: 'nvidia-smi',
      device: name,
    };

    if (best == null || reading.totalBytes > best.totalBytes) {
      best = reading;
    }
  }

  return best;
}

export interface ProbeGpuMemoryOptions {
  /** Rung 3's total. 0 or absent = unknown. */
  configuredTotalBytes?: number;
  /** Rung 3's "used": what Ollama itself reports resident. */
  residentBytes?: number;
  sysfsRoot?: string;
  exec?: ExecFileLike;
}

/** Walk the ladder in the doc comment above. `null` means no rung answered. */
export async function probeGpuMemory(options: ProbeGpuMemoryOptions = {}): Promise<GpuMemory | null> {
  const sysfs = await readSysfsGpuMemory(options.sysfsRoot);

  if (sysfs) {
    return sysfs;
  }

  const nvidia = await readNvidiaSmiGpuMemory(options.exec);

  if (nvidia) {
    return nvidia;
  }

  const totalBytes = options.configuredTotalBytes ?? 0;

  if (totalBytes > 0) {
    return {
      totalBytes,
      usedBytes: Math.min(totalBytes, options.residentBytes ?? 0),
      source: 'config',
    };
  }

  return null;
}
