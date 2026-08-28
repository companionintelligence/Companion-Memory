/**
 * The one place that owns import run/stage labelling and the small number
 * formatters the progress UI shares.
 *
 * Upstream this file carried twelve stage kinds, because the standalone app also
 * owned graph extraction, geocoding and search indexing. Here an import ends
 * when the user's data is in `ci.*`; what the appliance then does with it is
 * `ci.pipeline_runs`' business and has its own surface. So this is four stages,
 * deliberately.
 */

/**
 * Human label per stage kind, for the stage bar.
 *
 * `media` was missing until now, so every media stage rendered as the raw word
 * "media" with an EMPTY blurb underneath it — on a photo export that is the
 * longest leg of the whole import (weight 30, against parse's 35), and it was
 * the least explained thing on the screen.
 */
export const STAGE_LABELS: Record<string, string> = {
  unpack: 'Unpack',
  parse: 'Read',
  media: 'Store files',
  push: 'Save',
};

/** One line saying what each stage is doing, in the user's terms rather than ours. */
export const STAGE_BLURBS: Record<string, string> = {
  unpack: 'Expand the archive you uploaded',
  parse: 'Read what is inside it',
  media: 'Copy its photos, videos and voicemails into storage',
  push: 'Save it into your Companion Memory',
};

/** Order and short labels for the per-destination breakdown the push stage records. */
export const DESTINATION_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['events', 'events'],
  ['communications', 'messages'],
  ['content', 'documents'],
  ['things', 'things'],
  ['browser_activity', 'browsing'],
  ['position', 'locations'],
];

export function stageLabel(kind: string): string {
  return STAGE_LABELS[kind] ?? kind;
}

/**
 * `processed / total` clamped to 0..1, or null when there is no denominator.
 *
 * Null is the important case: it means indeterminate, and the bar must animate
 * rather than invent a width. A parse does not know how many records an archive
 * holds until it has read it.
 */
export function computeFraction(processed: number, total: number | null | undefined): number | null {
  if (total == null || total <= 0) {
    return null;
  }

  const fraction = processed / total;

  if (!Number.isFinite(fraction)) {
    return null;
  }

  return Math.min(1, Math.max(0, fraction));
}

/** 12_400 → "12.4k". Real imports run to hundreds of thousands of records. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  const abs = Math.abs(value);

  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }

  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }

  return String(Math.round(value));
}

/** "4m 12s" — coarse on purpose, because a second-accurate ETA over 40GB is a fiction. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ${Math.round(seconds % 60)}s`;
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatEta(seconds: number | null | undefined): string | null {
  const text = formatDuration(seconds);

  return text ? `${text} left` : null;
}

/**
 * A run's status in words a person can act on.
 *
 * `partial` is the one worth spelling out: it is a terminal SUCCESS, not a
 * failure, and calling it "Failed" is what teaches people to re-upload a 40GB
 * archive over one parser that choked.
 */
export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: 'Waiting to start',
  running: 'Importing',
  completed: 'Imported',
  partial: 'Imported, with some items skipped',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

/**
 * Turn a run's detected data-source names into what the catalogue calls them.
 *
 * Falls back to a de-underscored version of the raw name rather than hiding a
 * source the catalogue does not know about: a parser can outlive its catalogue
 * entry, and "kindle_reading" read badly but read.
 */
export function serviceLabels(
  names: readonly string[],
  sources: readonly { readonly name: string; readonly title: string }[],
): string[] {
  const titles = new Map(sources.map((source) => [source.name, source.title]));

  return names.map((name) => titles.get(name) ?? name.replace(/_/g, ' '));
}

/**
 * What to CALL the thing a run is importing.
 *
 * The single highest-value line on the progress surface, and the one that was
 * missing. A batch import starts one run per top-level folder and gives every
 * one of them the same label, so thirteen runs of a real 13-source corpus all
 * rendered as "qa-full-corpus" — indistinguishable, in a list whose whole job
 * is to tell you which one is stuck. The server now sends `unit`, the staged
 * archive or folder's own name; this makes it readable.
 *
 * `google-takeout` → `Google Takeout`, `whatsapp` → `Whatsapp`,
 * `takeout-20260819.zip` → `Takeout 20260819`. Archive extensions come off
 * because they are noise at a glance and the run's own row says it was a file.
 */
export function humanizeUnit(unit: string | null | undefined): string | null {
  if (unit == null) {
    return null;
  }

  const trimmed = unit.trim().replace(/\.(zip|tar|tgz|gz|7z|rar)$/i, '');

  if (trimmed.length === 0) {
    return null;
  }

  return trimmed
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * "555/s", "6.1/s", "1.2k/s" — throughput, at the precision it deserves.
 *
 * Recorded on every stage since the table was created and shown nowhere until
 * now. It is what separates "this parse is slow" from "this parse is big": on
 * the batch this was built against, a contact list ran at 6/s and a 704k-item
 * Takeout parse at 555/s, and only one of those was worth investigating.
 *
 * Below 10/s it keeps a decimal, because the difference between 6/s and 0.6/s
 * is the difference between an hour and half a day.
 */
export function formatRate(itemsPerSec: number | null | undefined): string | null {
  if (itemsPerSec == null || !Number.isFinite(itemsPerSec) || itemsPerSec <= 0) {
    return null;
  }

  if (itemsPerSec >= 1_000) {
    return `${(itemsPerSec / 1_000).toFixed(1)}k/s`;
  }

  if (itemsPerSec >= 10) {
    return `${Math.round(itemsPerSec)}/s`;
  }

  return `${itemsPerSec.toFixed(1)}/s`;
}

/** "1h 6m", "45m 34s", "1.9s" — an elapsed millisecond count, read at a glance. */
export function formatElapsed(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return null;
  }

  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }

  if (ms < 10_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }

  return formatDuration(Math.round(ms / 1_000));
}

/**
 * Say what a queued stage is actually doing, because "queued" says nothing.
 *
 * The appliance runs ONE import stage at a time across every run and every user,
 * so on a 13-source batch a stage can legitimately sit untouched for an hour.
 * The database calls that `queued`. It calls a stage whose own run has not
 * reached it yet `queued` as well. Those look identical on screen and one of
 * them is a bug — which is why the server distinguishes them and this turns the
 * distinction into words.
 *
 *  - `running`  → what it is doing right now
 *  - `waiting`  → in the queue, with its place in line
 *  - `blocked`  → not queued at all; an earlier stage of this run is still going
 *  - `done`     → finished, one way or another
 */
export function queueStateLabel(
  queueState: string,
  options: { position?: number | null; kind?: string } = {},
): string | null {
  if (queueState === 'waiting') {
    const { position, kind } = options;
    // Named by KIND, because the appliance queues per kind: a stage can be
    // eighth among everything waiting and still be next to run. "the read
    // queue" is also the answer to "waiting for what?", which "the import
    // queue" never was.
    const queue = kind == null ? 'import queue' : `${stageLabel(kind).toLowerCase()} queue`;

    if (position == null) {
      return 'Waiting for the importer';
    }

    return position === 1 ? `Next in the ${queue}` : `Waiting — ${ordinal(position)} in the ${queue}`;
  }

  if (queueState === 'blocked') {
    return 'Not started yet';
  }

  return null;
}

/**
 * "1 unpack, 1 read, 2 store files and 1 save" — the slots, said out loud.
 *
 * The sentence this feeds is what turns a queue twelve deep from a malfunction
 * into arithmetic. It is built from the server's own numbers rather than a
 * hardcoded "one at a time", which stopped being true the day media went to
 * two slots — a UI carrying its own copy of that would still be saying it.
 */
export function describeConcurrency(concurrency: Readonly<Record<string, number>>): string {
  const parts = Object.entries(concurrency)
    .filter(([, slots]) => slots > 0)
    .map(([kind, slots]) => `${slots} ${stageLabel(kind).toLowerCase()}`);

  if (parts.length === 0) {
    return 'one import stage';
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** 1 → "1st", 2 → "2nd", 13 → "13th". */
export function ordinal(value: number): string {
  const rest = value % 100;

  if (rest >= 11 && rest <= 13) {
    return `${value}th`;
  }

  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}
