/* Apple Health — streams export.xml in fixed-size chunks and extracts complete
 * XML elements, so multi-GB files never load fully into memory.
 *
 * History / why not line-based: the previous implementation scanned line by line
 * and required a literal `<Record ` (with trailing space) on a single line. Real
 * exports break both assumptions — Apple wraps long attribute lists across lines
 * (`<Record\n  type=...`) and some exports pack many elements onto one line. With
 * the line scanner a wrapped-tag export produced ZERO items (exit 0, no error)
 * and a compacted export produced one garbled item. This element-based parser
 * tokenises the stream into whole `<Record .../>`, `<Workout>…</Workout>`, and
 * `<ActivitySummary .../>` elements regardless of line boundaries. */
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { headMatches } from './sniff';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

/** Element/emit counters threaded through the streaming parse for diagnostics. */
interface Counters {
  records: number;
  workouts: number;
  summaries: number;
  emitted: number;
}

/** Extract attribute key="value" pairs from a tag string. */
function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    attrs[m[1]] = m[2];
  }

  return attrs;
}

/** Parse Apple Health date "YYYY-MM-DD HH:MM:SS +HHMM" → Date */
function parseHealthDate(s: string): Date | undefined {
  if (!s) {
    return undefined;
  }

  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);

    return isNaN(d.getTime()) ? undefined : d;
  }

  const d = new Date(s);

  return isNaN(d.getTime()) ? undefined : d;
}

export class AppleHealthFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    // 'export.xml' is the most generic filename in this whole registry; the
    // HealthKit root element is not. One 4 KB read tells them apart.
    const isHealthExport = (fpath: string) => headMatches(fpath, /<HealthData\b/);

    if (st.isFile()) {
      return path.basename(root).toLowerCase() === 'export.xml' && (await isHealthExport(root))
        ? { confidence: 0.95 }
        : { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        if (names.includes('export.xml') && (await isHealthExport(path.join(root, 'export.xml')))) {
          return { confidence: 0.95 };
        }

        if (names.includes('export_cda.xml')) {
          return { confidence: 0.7 };
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let exportPath = root;
    try {
      if (fs.statSync(root).isDirectory()) {
        exportPath = path.join(root, 'export.xml');
        if (!fs.existsSync(exportPath)) {
          params.log?.('warn', 'Apple Health: export.xml not found in directory');

          return;
        }
      }
    } catch {
      return;
    }

    // `seen` counts elements found; `emitted` counts items actually pushed
    // (timeframe filtering can drop some), so a zero-item run can report whether
    // the file was empty/unrecognised vs. fully filtered out. ImportPipeline is
    // push-only (no .length), so we count via these helpers.
    const seen: Counters = { records: 0, workouts: 0, summaries: 0, emitted: 0 };

    // Stream in fixed-size chunks; keep a sliding buffer and extract complete
    // top-level elements. Elements may span chunk and line boundaries.
    const stream = fs.createReadStream(exportPath, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let buf = '';
    for await (const chunk of stream) {
      buf += chunk as string;
      buf = this.drainElements(buf, params, seen);
      // Guard against an unbounded buffer if a malformed file never closes a
      // <Workout> (or has a single colossal token): once the buffer is huge and
      // holds no element opener, drop everything before the last '<'.
      if (buf.length > 1 << 23) {
        const lastOpen = buf.lastIndexOf('<');
        buf = lastOpen > 0 ? buf.slice(lastOpen) : '';
      }
    }

    // Flush any trailing buffered element.
    this.drainElements(buf, params, seen, true);

    if (seen.emitted === 0) {
      // Make the "37 GB → 0 items" outcome loud instead of silent.
      params.log?.(
        'warn',
        'Apple Health: parsed export.xml but produced 0 timeline items — no <Record>/<Workout>/<ActivitySummary> elements were extracted (file may be empty, malformed, or an unsupported variant).',
        { recordsSeen: seen.records, workoutsSeen: seen.workouts, summariesSeen: seen.summaries },
      );
    } else {
      params.log?.('info', 'Apple Health: imported timeline items', {
        items: seen.emitted,
        records: seen.records,
        workouts: seen.workouts,
        summaries: seen.summaries,
      });
    }
  }

  /**
   * Extract every complete `<Record .../>`, `<Workout>…</Workout>`, and
   * `<ActivitySummary .../>` element from the front of `buf`, push each, and
   * return the unconsumed tail (a partial element straddling the next chunk).
   * When `final` is true, a trailing self-closed element with no following '<'
   * is still flushed.
   */
  private drainElements(buf: string, params: ImportParams, seen: Counters, final = false): string {
    let work = buf;
    for (;;) {
      const open = this.nextElementOpen(work);
      if (open === null) {
        // No further element opener. Keep a small tail (a partial '<...') so an
        // opener split across the chunk boundary survives.
        const lastOpen = work.lastIndexOf('<');

        return lastOpen >= 0 ? work.slice(lastOpen) : '';
      }

      const { index, name } = open;

      if (name === 'Workout') {
        // Block element: needs the matching close (or a self-close).
        const selfClose = this.selfCloseEnd(work, index);
        const closeIdx = work.indexOf('</Workout>', index);
        if (selfClose !== -1 && (closeIdx === -1 || selfClose < closeIdx)) {
          this.pushWorkout(work.slice(index, selfClose + 2), params, seen);
          seen.workouts++;
          work = work.slice(selfClose + 2);
          continue;
        }

        if (closeIdx !== -1) {
          const end = closeIdx + '</Workout>'.length;
          this.pushWorkout(work.slice(index, end), params, seen);
          seen.workouts++;
          work = work.slice(end);
          continue;
        }

        // Incomplete <Workout> — wait for more input (unless this is the final
        // flush, in which case there is nothing more to wait for).
        return final ? '' : work.slice(index);
      }

      // <Record .../> and <ActivitySummary .../> are self-closing (Record may
      // also carry children; we only need the opening tag's attributes).
      const tagEnd = this.tagEnd(work, index);
      if (tagEnd === -1) {
        // Opening tag not yet complete in this buffer.
        return final ? '' : work.slice(index);
      }

      const tag = work.slice(index, tagEnd + 1);
      if (name === 'Record') {
        this.pushRecord(tag, params, seen);
        seen.records++;
      } else if (name === 'ActivitySummary') {
        this.pushActivitySummary(tag, params, seen);
        seen.summaries++;
      }

      work = work.slice(tagEnd + 1);
    }
  }

  /** Index + tag name of the next Record/Workout/ActivitySummary opener. */
  private nextElementOpen(s: string): { index: number; name: string } | null {
    const re = /<(Record|Workout|ActivitySummary)(?=[\s/>])/g;
    const m = re.exec(s);

    return m ? { index: m.index, name: m[1] } : null;
  }

  /** Index of the '>' that closes the tag opening at `from` (or -1). */
  private tagEnd(s: string, from: number): number {
    return s.indexOf('>', from);
  }

  /** If the tag opening at `from` self-closes ('/>'), index of the '/' (or -1). */
  private selfCloseEnd(s: string, from: number): number {
    const gt = s.indexOf('>', from);
    if (gt === -1) {
      return -1;
    }

    return s[gt - 1] === '/' ? gt - 1 : -1;
  }

  private pushRecord(line: string, params: ImportParams, seen: Counters): void {
    const attrs = parseAttrs(line);
    const ts = parseHealthDate(attrs.startDate);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const type = attrs.type ?? '';
    const value = attrs.value;
    const unit = attrs.unit;
    seen.emitted++;
    params.pipeline.push({
      item: {
        id: `apple_health:record:${attrs.type ?? ''}:${attrs.sourceName ?? ''}:${attrs.startDate ?? ''}:${attrs.endDate ?? ''}:${value ?? ''}:${unit ?? ''}:${seen.records}`,
        classification: type === 'HKCategoryTypeIdentifierSleepAnalysis' ? 'sleep' : 'health',
        timestamp: ts,
        timespanEnd: parseHealthDate(attrs.endDate),
        content: {
          filename: 'health_record.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(`${type}: ${value} ${unit}`.trim()),
        },
        metadata: {
          Title: type
            ? `${type.replace(/^HK\w*?Identifier/, '')}: ${value ?? ''} ${unit ?? ''}`.trim()
            : undefined,
          Type: type || undefined,
          Value: value !== undefined && !isNaN(Number(value)) ? Number(value) : value || undefined,
          Unit: unit || undefined,
          Source: attrs.sourceName || undefined,
        },
      },
    });
  }

  private pushWorkout(block: string, params: ImportParams, seen: Counters): void {
    // Parse only the opening <Workout …> tag (whitespace-insensitive, so wrapped
    // attribute lists work) — NOT the whole block, so nested <MetadataEntry>
    // children don't leak their key/value attrs into the workout's metadata.
    const tagMatch = /<Workout\b([^>]*)/.exec(block);
    if (!tagMatch) {
      return;
    }

    const attrs = parseAttrs(tagMatch[1]);
    const ts = parseHealthDate(attrs.startDate);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const actType = (attrs.workoutActivityType ?? '').replace('HKWorkoutActivityType', '');
    seen.emitted++;
    params.pipeline.push({
      item: {
        id: `apple_health:workout:${actType}:${attrs.sourceName ?? ''}:${attrs.startDate ?? ''}:${attrs.endDate ?? ''}:${seen.workouts}`,
        classification: 'workout',
        timestamp: ts,
        timespanEnd: parseHealthDate(attrs.endDate),
        content: { filename: 'workout.txt', mediaType: 'text/plain', data: async () => Buffer.from(actType) },
        metadata: {
          Title: actType || undefined,
          'Activity Type': actType || undefined,
          'Duration (min)': attrs.duration ? parseFloat(attrs.duration) : undefined,
          Distance: attrs.totalDistance
            ? `${attrs.totalDistance} ${attrs.totalDistanceUnit ?? ''}`.trim()
            : undefined,
          Calories: attrs.totalEnergyBurned ? parseFloat(attrs.totalEnergyBurned) : undefined,
          Source: attrs.sourceName || undefined,
        },
      },
    });
  }

  private pushActivitySummary(line: string, params: ImportParams, seen: Counters): void {
    const attrs = parseAttrs(line);
    const dateStr = attrs.dateComponents;
    if (!dateStr) {
      return;
    }

    const ts = new Date(dateStr);
    if (isNaN(ts.getTime()) || !timeframeContains(params.timeframe, ts)) {
      return;
    }

    seen.emitted++;
    params.pipeline.push({
      item: {
        id: `apple_health:summary:${dateStr}`,
        classification: 'health',
        timestamp: ts,
        content: {
          filename: 'activity_summary.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(dateStr),
        },
        metadata: {
          Title: dateStr ? `Activity Summary ${dateStr}` : 'Activity Summary',
          Type: 'ActivitySummary',
          'Active Energy (kcal)': attrs.activeEnergyBurned ? parseFloat(attrs.activeEnergyBurned) : undefined,
          'Exercise (min)': attrs.appleExerciseTime ? parseFloat(attrs.appleExerciseTime) : undefined,
          'Stand Hours': attrs.appleStandHours ? parseFloat(attrs.appleStandHours) : undefined,
        },
      },
    });
  }
}

registerDataSource({
  name: 'apple_health',
  title: 'Apple Health',
  icon: '',
  description: 'Steps, heart rate, sleep, workouts, cycles, and every sensor reading from Apple Health.',
  newFileImporter: () => new AppleHealthFileImporter(),
});
