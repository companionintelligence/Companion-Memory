import { stat } from 'node:fs/promises';
import path from 'node:path';

import { IMPORT_STAGE_KINDS } from '../wire';
import { CliError, type CliContext } from '../context';
import { bytes, csv, json, table } from '../output';
import { waitForRuns } from '../wait';

export interface ImportOptions {
  label?: string;
  stages?: string;
  wait?: boolean;
  timeout?: string;
  json?: boolean;
}

interface ImportResult {
  path: string;
  sizeBytes?: number;
  runId?: string;
  label?: string | null;
  error?: string;
}

/**
 * Import archives from this machine.
 *
 * The bytes are UPLOADED, exactly as the web wizard uploads them, and the run
 * then consumes the staged copy. That is a deliberate choice over pointing the
 * appliance at the path in place, and it is what makes this command work with
 * no configuration at all: `CI_IMPORT_ROOTS` gates paths the SERVER reads, and
 * an upload asks the server to read nothing. It also means the CLI is no more
 * privileged than a browser — the same authority, through the same door, which
 * is the property worth keeping when the credential is an api key in an
 * environment variable.
 *
 * Per-path isolation, like the inbox batch: one unreadable archive records its
 * error and its siblings still start. The exit code is non-zero if ANY named
 * path failed, because the caller named each one explicitly.
 */
export async function importCommand(
  ctx: CliContext,
  targets: readonly string[],
  options: ImportOptions = {},
): Promise<void> {
  if (targets.length === 0) {
    throw new CliError('usage: ci import <path...>');
  }

  const stages = parseStages(options.stages);
  // Parsed before anything is uploaded. A bad --timeout used to surface only
  // once the runs had started, so the command failed with its imports already
  // under way.
  const timeoutMs = parseTimeout(options.timeout);

  if (stages != null && !stages.includes('media') && stages.includes('parse')) {
    // Worth a warning rather than a refusal: `--stages unpack,parse` is a
    // legitimate "stage it now, push later" request. But a run that parses
    // photos without storing their bytes leaves the scratch tree the only copy,
    // and the scratch tree is reclaimed with the run.
    ctx.term.err(
      `warning: --stages omits 'media'. Photo and video bytes are stored by that stage; ` +
        `without it a completed run has parsed the media and kept none of it.`,
    );
  }

  const results: ImportResult[] = [];

  for (const target of targets) {
    const resolved = path.resolve(target);

    try {
      const info = await stat(resolved);

      if (info.isDirectory()) {
        // An upload is one set of bytes; a directory has none. The inbox is the
        // surface built for trees, and it consumes them in place rather than
        // copying a Takeout across an HTTP connection.
        throw new Error(
          `is a directory. Move it into the import inbox and run \`ci inbox --start\`, ` +
            `or point this at the archive file itself.`,
        );
      }

      if (!info.isFile()) {
        throw new Error('is not a regular file');
      }

      const [drop] = await ctx.client.upload(resolved);

      if (drop == null) {
        throw new Error('the appliance staged no upload for it');
      }

      const run = await ctx.client.startRun({
        dropId: drop.dropId,
        label: options.label,
        stages,
      });

      results.push({ path: resolved, sizeBytes: info.size, runId: run.id, label: run.label });
    } catch (err) {
      // A non-Error rejection would otherwise record `error: undefined`, and
      // the path would count as neither started nor failed.
      results.push({ path: resolved, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const started = results.filter((result) => result.runId != null);
  const failed = results.filter((result) => result.error != null);

  if (options.json) {
    json(ctx.term, results);
  } else {
    ctx.term.out(
      table(results, [
        { header: 'archive', value: (result) => path.basename(result.path) },
        { header: 'size', value: (result) => bytes(result.sizeBytes), align: 'right' },
        { header: 'run', value: (result) => result.runId ?? '' },
        { header: 'status', value: (result) => (result.error == null ? 'started' : 'failed') },
      ]),
    );

    for (const result of failed) {
      ctx.term.err(`${result.path}: ${result.error}`);
    }

    if (started.length > 0) {
      ctx.term.out(
        `\n${started.length} run(s) started. They continue in the background — ` +
          `follow one with \`ci runs <id>\`.`,
      );
    }
  }

  if (options.wait && started.length > 0) {
    await waitForRuns(
      ctx.client,
      ctx.term,
      started.map((result) => result.runId as string),
      { timeoutMs, quiet: options.json },
    );
  }

  if (failed.length > 0) {
    throw new CliError(
      `${failed.length} of ${results.length} path(s) could not be imported.`,
      started.length > 0 ? 2 : 1,
    );
  }
}

/** Validate `--stages` here, where a typo is still cheap to fix. */
export function parseStages(value: string | undefined): string[] | undefined {
  const stages = csv(value);

  if (stages == null) {
    return undefined;
  }

  const unknown = stages.filter((stage) => !(IMPORT_STAGE_KINDS as readonly string[]).includes(stage));

  if (unknown.length > 0) {
    throw new CliError(
      `Unknown stage(s): ${unknown.join(', ')}. Valid stages, in order: ${IMPORT_STAGE_KINDS.join(', ')}`,
    );
  }

  return stages;
}

/** `--timeout` in seconds; 0 or absent means wait as long as it takes. */
export function parseTimeout(value: string | undefined): number {
  if (value == null) {
    return 0;
  }

  const seconds = Number(value);

  // `Number('')` is 0, so a blank value (`--timeout "$UNSET"` in a script)
  // would otherwise mean "no limit" without a word.
  if (value.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
    throw new CliError(`--timeout takes a number of seconds, not "${value}"`);
  }

  // A positive value never rounds down to 0, which would also mean "no limit".
  return seconds > 0 ? Math.max(1, Math.round(seconds * 1000)) : 0;
}
