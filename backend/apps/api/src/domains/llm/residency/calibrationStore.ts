/**
 * On-disk memory of what each model REALLY cost when it was last seen loaded.
 *
 * `estimateFootprintBytes` is an upper bound from GGUF metadata. For hybrid
 * architectures that bound is far too high — qwen3.5 stores `head_count_kv`
 * per layer, which the JSON API drops, so the formula counts every head on
 * every fourth layer and lands at 29 GiB where Ollama itself predicts 17.9.
 * One sighting in `/api/ps` (weights, `size_vram`, `context_length`) tightens
 * that to 18.5 GiB. Those sightings used to live in process memory and die
 * with it, so every restart went back to refusing models that fit. This file
 * keeps them.
 *
 * Same path convention as `llm-endpoint.json` (see `llmEndpointShared.ts`):
 * `APP_DATA_DIR/data/` when the Hub gave us a data dir, an explicit
 * `LLM_RESIDENCY_CALIBRATION_PATH`, and a dotfile in the working directory as
 * the dev fallback. Every readable path is tried on load (first hit wins);
 * every path is written on save, best effort. Writes are atomic (temp file +
 * rename) so a crash mid-write leaves the previous file, not half a JSON.
 *
 * The content is a small map of model id → numbers. It carries no credential,
 * so unlike `llm-endpoint.json` it is written with default permissions.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ResidencyObservation } from './footprint';

export const CALIBRATION_FILE_VERSION = 1;

export interface CalibrationRecord extends ResidencyObservation {
  /** ISO-8601, when this sighting was taken. Informational. */
  seenAt: string;
}

export interface CalibrationFile {
  version: typeof CALIBRATION_FILE_VERSION;
  observations: Record<string, CalibrationRecord>;
}

export interface CalibrationStoreLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

function isRecord(value: unknown): value is CalibrationRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.numCtx === 'number' &&
    record.numCtx > 0 &&
    typeof record.sizeVramBytes === 'number' &&
    record.sizeVramBytes > 0 &&
    typeof record.weightBytes === 'number' &&
    record.weightBytes > 0
  );
}

export class CalibrationStore {
  constructor(
    private readonly paths: readonly string[],
    private readonly logger?: CalibrationStoreLogger,
  ) {}

  /** The path ladder described in the module doc, de-duplicated, in read priority order. */
  static defaultPaths(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string[] {
    const paths: string[] = [];
    const explicit = env.LLM_RESIDENCY_CALIBRATION_PATH?.trim();
    const appDataDir = env.APP_DATA_DIR?.trim();

    if (explicit) {
      paths.push(explicit);
    }

    if (appDataDir) {
      paths.push(join(appDataDir, 'data', 'llm-residency-calibration.json'));
    }

    paths.push(join(cwd, '.llm-residency-calibration.json'));

    return [...new Set(paths)];
  }

  /** First readable, well-formed file wins. Malformed or missing files are skipped silently. */
  load(): Map<string, CalibrationRecord> {
    for (const path of this.paths) {
      if (!existsSync(path)) {
        continue;
      }

      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CalibrationFile>;

        if (parsed.version !== CALIBRATION_FILE_VERSION || typeof parsed.observations !== 'object') {
          continue;
        }

        const observations = new Map<string, CalibrationRecord>();

        for (const [model, record] of Object.entries(parsed.observations ?? {})) {
          if (isRecord(record)) {
            observations.set(model, {
              numCtx: record.numCtx,
              sizeVramBytes: record.sizeVramBytes,
              weightBytes: record.weightBytes,
              seenAt: typeof record.seenAt === 'string' ? record.seenAt : new Date(0).toISOString(),
            });
          }
        }

        return observations;
      } catch (error) {
        this.logger?.warn('Ignoring an unreadable residency calibration file', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return new Map();
  }

  /** Write to every path, best effort. Returns the paths that were written. */
  save(observations: ReadonlyMap<string, CalibrationRecord>): string[] {
    const file: CalibrationFile = {
      version: CALIBRATION_FILE_VERSION,
      observations: Object.fromEntries([...observations.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    const body = `${JSON.stringify(file, null, 2)}\n`;
    const written: string[] = [];

    for (const path of this.paths) {
      try {
        mkdirSync(dirname(path), { recursive: true });

        const temp = `${path}.${process.pid}.tmp`;

        writeFileSync(temp, body);
        renameSync(temp, path);
        written.push(path);
      } catch (error) {
        this.logger?.warn('Could not persist residency calibration', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return written;
  }
}
