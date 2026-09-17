import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

const execFileAsync = promisify(execFile);

/**
 * Longest a single decode+resize may run. A 200 MP HEIC decodes in a few
 * seconds on a laptop core; anything past this is a pathological file, and
 * the caller classifies a timeout as undecodable rather than retrying it.
 */
const VIPS_TIMEOUT_MS = 120_000;

/** What the header of an encoded image says about it, before any rotation. */
export interface ImageProbe {
  /** Stored pixel width, as encoded — NOT corrected for EXIF orientation. */
  width: number;
  /** Stored pixel height, as encoded. */
  height: number;
  /** EXIF orientation 1–8; 1 when the file carries no tag. */
  orientation: number;
  /** The libvips loader that claimed the file (`jpegload`, `heifload`, …). */
  loader: string | null;
}

export interface JpegRenderOptions {
  /** The rendition fits inside a square of this side; never upscaled. */
  maxDimension: number;
  /** JPEG quality 1–100 (default 80). */
  quality?: number;
}

/** A rendered JPEG plus its dimensions, already rotated upright. */
export interface RenderedJpeg {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * The `vips` / `vipsheader` executables are not on PATH. Distinct from a
 * decode failure on purpose: a missing tool is a deployment fault that must
 * surface loudly and retry, never be recorded per-file as "undecodable".
 */
export class VipsUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `libvips command-line tools are not installed (${cause}). ` +
        'Install `libvips-tools` (Debian/Ubuntu) or `vips` (Homebrew).',
    );
    this.name = 'VipsUnavailableError';
  }
}

/** libvips ran and rejected the bytes: not an image, or a format it cannot decode. */
export class VipsDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VipsDecodeError';
  }
}

/**
 * Image decoding and resizing through the system libvips command-line tools.
 *
 * This replaced `sharp` deliberately. sharp IS libvips, but the prebuilt
 * binary it ships links a libheif with no HEVC decoder (patent licensing), so
 * every iPhone HEIC failed to decode: 52 of 53 HEIC originals in the first
 * imported library had no preview and, because description hangs off the
 * preview event, were never described either. Debian's `libvips-tools`
 * package links `libde265` and decodes them in under a second. Building
 * sharp against a system libvips instead was rejected: sharp 0.35 needs
 * libvips ≥ 8.18.6, newer than any Debian release packages, so it would have
 * been a from-source build in the image that developer machines (which run
 * the API on the host) would not share.
 *
 * Runs as a child process per call. Measured against in-process sharp on a
 * 12 MP JPEG: 70 ms vs 28 ms for a thumbnail — the process spawn — which is
 * noise next to the vision-model call the pipeline exists to feed.
 *
 * Both entry points take a Buffer and spool it to a temp file: `vipsheader`
 * reads files only, and the resize needs the source seekable anyway.
 */
@Injectable()
export class VipsService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(VipsService.name);
  }

  /**
   * Read width, height, orientation and loader from an image's header.
   *
   * @throws VipsDecodeError when libvips does not recognise the bytes.
   * @throws VipsUnavailableError when the tools are not installed.
   */
  async probe(buffer: Buffer): Promise<ImageProbe> {
    return this.withTempFile(buffer, async (input) => this.probeFile(input));
  }

  /**
   * Render an upright JPEG that fits inside `maxDimension` square. EXIF and
   * HEIF orientation are applied and then stripped, so the output displays
   * the same everywhere without a tag. Never upscales.
   *
   * `fail-on=error`, not libvips' default `warning`: real phone JPEGs —
   * Samsung above all — routinely carry warning-level defects (stray bytes
   * before restart markers) that every viewer decodes fine; the stricter
   * default turned ~8% of a sampled Takeout batch into failed preview jobs.
   *
   * @throws VipsDecodeError when libvips cannot decode the bytes.
   * @throws VipsUnavailableError when the tools are not installed.
   */
  async renderJpeg(buffer: Buffer, options: JpegRenderOptions): Promise<RenderedJpeg> {
    const quality = options.quality ?? 80;

    return this.withTempFile(buffer, async (input) => {
      const output = `${input}-out.jpg`;

      try {
        await this.run('vips', [
          'thumbnail',
          `${input}[fail-on=error]`,
          `${output}[Q=${quality},strip]`,
          String(options.maxDimension),
          '--height',
          String(options.maxDimension),
          // `down`: fit inside, shrink only — a 64px source stays 64px.
          '--size',
          'down',
        ]);

        const [rendered, header] = await Promise.all([fs.readFile(output), this.probeFile(output)]);

        return { buffer: rendered, width: header.width, height: header.height };
      } finally {
        await fs.unlink(output).catch(() => {});
      }
    });
  }

  private async probeFile(path: string): Promise<ImageProbe> {
    const { stdout } = await this.run('vipsheader', ['-a', path]);
    const fields = new Map<string, string>();

    for (const line of stdout.split('\n')) {
      const colon = line.indexOf(':');

      if (colon > 0) {
        fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
    }

    const width = Number(fields.get('width'));
    const height = Number(fields.get('height'));

    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new VipsDecodeError(`vipsheader returned no usable dimensions for ${path}`);
    }

    const orientation = Number(fields.get('orientation') ?? '1');

    return {
      width,
      height,
      orientation: Number.isInteger(orientation) && orientation >= 1 && orientation <= 8 ? orientation : 1,
      loader: fields.get('vips-loader') ?? null,
    };
  }

  private async run(command: string, args: string[]): Promise<{ stdout: string }> {
    try {
      const { stdout } = await execFileAsync(command, args, {
        timeout: VIPS_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });

      return { stdout };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };

      if (error.code === 'ENOENT') {
        throw new VipsUnavailableError(`${command} not found on PATH`);
      }

      const detail = (error.stderr ?? error.message ?? String(err)).trim();

      if (error.killed) {
        throw new VipsDecodeError(`${command} exceeded ${VIPS_TIMEOUT_MS}ms: ${detail}`);
      }

      throw new VipsDecodeError(detail || `${command} exited with an error`);
    }
  }

  private async withTempFile<T>(buffer: Buffer, fn: (path: string) => Promise<T>): Promise<T> {
    const path = join(tmpdir(), `ci-vips-${crypto.randomUUID()}`);

    try {
      await fs.writeFile(path, buffer);

      return await fn(path);
    } finally {
      await fs.unlink(path).catch(() => {});
    }
  }
}
