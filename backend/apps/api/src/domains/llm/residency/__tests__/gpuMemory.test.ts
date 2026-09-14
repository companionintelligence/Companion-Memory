import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeGpuMemory, readNvidiaSmiGpuMemory, readSysfsGpuMemory } from '../gpuMemory';

async function sysfsFixture(cards: Record<string, { total: number; used: number } | null>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'drm-'));

  for (const [card, mem] of Object.entries(cards)) {
    const device = join(root, card, 'device');

    await mkdir(device, { recursive: true });

    if (mem) {
      await writeFile(join(device, 'mem_info_vram_total'), `${mem.total}\n`);
      await writeFile(join(device, 'mem_info_vram_used'), `${mem.used}\n`);
    }
  }

  return root;
}

describe('readSysfsGpuMemory', () => {
  it('picks the card with the largest total — the 512 MiB iGPU is not the GPU', async () => {
    const root = await sysfsFixture({
      card0: { total: 536_870_912, used: 26_058_752 },
      card1: { total: 25_753_026_560, used: 22_240_452_608 },
      'card1-DP-1': null,
    });

    await expect(readSysfsGpuMemory(root)).resolves.toEqual({
      totalBytes: 25_753_026_560,
      usedBytes: 22_240_452_608,
      source: 'sysfs',
      device: 'card1',
    });
  });

  it('returns null when no card exposes the counters (NVIDIA, or no GPU)', async () => {
    await expect(readSysfsGpuMemory(await sysfsFixture({ card0: null }))).resolves.toBeNull();
    await expect(readSysfsGpuMemory('/nonexistent/drm')).resolves.toBeNull();
  });
});

describe('readNvidiaSmiGpuMemory', () => {
  it('parses MiB rows and keeps the largest card', async () => {
    const exec = jest.fn(async () => ({
      stdout: 'NVIDIA RTX A2000, 1200, 6144\nNVIDIA RTX 4090, 3000, 24564\n',
    }));

    await expect(readNvidiaSmiGpuMemory(exec)).resolves.toEqual({
      totalBytes: 24_564 * 1024 * 1024,
      usedBytes: 3_000 * 1024 * 1024,
      source: 'nvidia-smi',
      device: 'NVIDIA RTX 4090',
    });
  });

  it('treats a missing binary as no reading, not an error', async () => {
    const exec = jest.fn(async () => {
      throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    });

    await expect(readNvidiaSmiGpuMemory(exec)).resolves.toBeNull();
  });
});

describe('probeGpuMemory', () => {
  it('falls back to the configured total with Ollama residents as "used"', async () => {
    const reading = await probeGpuMemory({
      sysfsRoot: '/nonexistent/drm',
      exec: async () => {
        throw new Error('ENOENT');
      },
      configuredTotalBytes: 24 * 1024 ** 3,
      residentBytes: 18 * 1024 ** 3,
    });

    expect(reading).toEqual({ totalBytes: 24 * 1024 ** 3, usedBytes: 18 * 1024 ** 3, source: 'config' });
  });

  it('is null when nothing answers and no total is configured', async () => {
    await expect(
      probeGpuMemory({
        sysfsRoot: '/nonexistent/drm',
        exec: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).resolves.toBeNull();
  });
});
