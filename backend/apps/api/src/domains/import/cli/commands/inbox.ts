import type { InboxUnit } from '../../services/ImportInboxService';
import { CliError, type CliContext } from '../context';
import { bytes, csv, json, table } from '../output';
import { waitForRuns } from '../wait';

import { parseTimeout } from './import';

export interface InboxOptions {
  /**
   * Actually import. Absent, this command only LOOKS.
   *
   * The deliberate difference from upstream, where a bare `ci-import inbox`
   * imported everything it found. There the inbox was a folder on your own
   * laptop; here `unpack` acquires by RENAME, so starting a run takes the file
   * out of the inbox and a mistake is not a re-run away. Scanning is the safe
   * default and importing is a verb you type.
   */
  start?: boolean;
  /** Keep only units recognized as these data sources. */
  only?: string;
  /** Drop units recognized as these data sources. */
  skip?: string;
  /** Exact unit paths from a scan, instead of a recognition filter. */
  units?: string;
  label?: string;
  wait?: boolean;
  timeout?: string;
  json?: boolean;
}

/** What is waiting in the inbox folder — and, on request, importing it. */
export async function inboxCommand(ctx: CliContext, options: InboxOptions = {}): Promise<void> {
  const scan = await ctx.client.scanInbox();

  if (!scan.available) {
    throw new CliError(
      `${scan.reason ?? 'The inbox is not available.'}\n` +
        `The appliance expects it at ${scan.inboxDir} (CI_IMPORT_INBOX_DIR).`,
    );
  }

  const selected = select(scan.units, options);

  if (!options.start) {
    if (options.json) {
      json(ctx.term, { ...scan, units: selected });

      return;
    }

    ctx.term.out(
      table(
        selected,
        [
          { header: 'unit', value: (unit) => unit.path },
          { header: 'kind', value: (unit) => unit.kind },
          // `~` marks a unit whose walk stopped at MAX_UNIT_SIZING_ENTRIES: the
          // service already knows the figure is a floor (`sizeApproximate`) and
          // printing it bare states a measurement it did not make. Measured on a
          // 79,623-file Google Takeout, the bare numbers read 49,788 files and
          // 3.0GB against an actual 4.3GB — 37% and 30% short, with nothing to
          // say so.
          {
            header: 'size',
            value: (unit) => `${unit.sizeApproximate ? '~' : ''}${bytes(unit.sizeBytes)}`,
            align: 'right',
          },
          {
            header: 'files',
            value: (unit) => `${unit.fileCount}${unit.sizeApproximate ? '+' : ''}`,
            align: 'right',
          },
          {
            header: 'recognized',
            value: (unit) =>
              unit.recognized
                .slice(0, 3)
                .map((match) => `${match.dataSource}(${match.confidence.toFixed(2)})`)
                .join(' '),
          },
          { header: 'status', value: (unit) => (unit.claimed ? 'importing' : 'ready') },
        ],
        `Nothing in ${scan.displayDir}.`,
      ),
    );

    const ready = selected.filter((unit) => !unit.claimed).length;

    if (selected.length > 0) {
      ctx.term.out(`\n${selected.length} unit(s) in ${scan.displayDir}, ${ready} ready.`);
    }

    if (scan.skippedSymlinks > 0) {
      // Never adjudicated, always reported: the inbox consumes what it imports,
      // so a link reaching out of it points at bytes the importer does not own.
      ctx.term.out(`${scan.skippedSymlinks} symlink(s) skipped — the inbox never follows links.`);
    }

    if (scan.truncated) {
      ctx.term.out('The scan hit its walk limits; some units are not listed.');
    }

    if (scan.recognitionPartial) {
      // The failure this prevents is silent and specific: recognition runs
      // under one scan-wide deadline, so the biggest unit can exhaust it and
      // come back with an EMPTY `recognized` list. That unit then matches no
      // `--only <source>`, and the run reports success over a smaller corpus
      // than the operator asked for. A unit listed with no parsers at all is
      // the tell.
      const unnamed = selected.filter((unit) => unit.recognized.length === 0);

      ctx.term.out(
        `Recognition ran out of budget${
          unnamed.length > 0 ? ` — no parsers listed for: ${unnamed.map((u) => u.path).join(', ')}` : ''
        }. Those units will NOT match \`--only\`; re-run to let recognition finish, or pass their paths explicitly.`,
      );
    }

    const approximate = selected.filter((unit) => unit.sizeApproximate);

    if (approximate.length > 0) {
      ctx.term.out(
        `~ and + mark floors, not measurements: sizing stopped early for ${approximate
          .map((u) => u.path)
          .join(', ')}.`,
      );
    }

    if (ready > 0) {
      ctx.term.out('\nImport them with `ci-import inbox --start`. The inbox consumes what it imports.');
    }

    return;
  }

  const startable = selected.filter((unit) => !unit.claimed);

  if (startable.length === 0) {
    throw new CliError(
      selected.length === 0
        ? `Nothing to import in ${scan.displayDir}.`
        : `All ${selected.length} matching unit(s) are already being imported.`,
    );
  }

  const batch = await ctx.client.startInboxRuns(
    startable.map((unit) => unit.path),
    options.label ?? null,
  );

  const started = batch.results.filter((result) => result.runId != null);
  const failed = batch.results.filter((result) => result.error != null);

  if (options.json) {
    json(ctx.term, batch);
  } else {
    ctx.term.out(
      table(batch.results, [
        { header: 'unit', value: (result) => result.unit },
        { header: 'run', value: (result) => result.runId ?? '' },
        { header: 'status', value: (result) => (result.error == null ? 'started' : 'failed') },
      ]),
    );

    for (const result of failed) {
      ctx.term.err(`${result.unit}: ${result.error}`);
    }

    ctx.term.out(`\n${started.length} of ${batch.results.length} unit(s) started.`);
  }

  if (options.wait && started.length > 0) {
    await waitForRuns(
      ctx.client,
      ctx.term,
      started.map((result) => result.runId as string),
      { timeoutMs: parseTimeout(options.timeout), quiet: options.json },
    );
  }

  if (started.length === 0) {
    throw new CliError('No unit could be started.', 1);
  }
}

/**
 * Narrow a scan to what the caller asked for.
 *
 * `--units` is an exact-path filter and wins outright; `--only`/`--skip` match
 * on the RECOGNIZED data source, which is upstream's vocabulary and the one a
 * person thinks in ("import the photos, not the mail"). A unit nothing
 * recognizes survives `--skip` and fails `--only`, which is the conservative
 * reading of both: skip removes what you named, only keeps what you named.
 */
export function select(units: readonly InboxUnit[], options: InboxOptions): InboxUnit[] {
  const wanted = csv(options.units);

  if (wanted != null) {
    const set = new Set(wanted);
    const matched = units.filter((unit) => set.has(unit.path));
    const missing = wanted.filter((path) => !units.some((unit) => unit.path === path));

    if (missing.length > 0) {
      throw new CliError(`Not in the inbox scan: ${missing.join(', ')}`);
    }

    return matched;
  }

  const only = csv(options.only);
  const skip = csv(options.skip);

  return units.filter((unit) => {
    const sources = unit.recognized.map((match) => match.dataSource);

    if (only != null && !sources.some((source) => only.includes(source))) {
      return false;
    }

    if (skip != null && sources.some((source) => skip.includes(source))) {
      return false;
    }

    return true;
  });
}
