/* Garmin Connect account export ("Export Data" on the Data Management page).

   The download is a zip with a DI_CONNECT/ folder of JSON, not the
   Activities.csv the Activities list exports. Two of its files are read here:

   DI-Connect-Fitness/<account>_<n>_summarizedActivities.json, one entry per
   activity:
     [ { "summarizedActivitiesExport": [ { "activityId": 17012345601,
           "name": "Forest Park Running", "activityType": "running",
           "startTimeGmt": 1775916201000.0, "duration": 2711000.0,
           "distance": 742000.0, "avgHr": 151.0, ... } ] } ]
   startTimeGmt is epoch milliseconds, duration is milliseconds and distance is
   centimetres. Garmin documents none of this; it is what the numbers in real
   exports agree on (avgSpeed is distance / duration in those units, so
   0.2737 there is 2.737 m/s).

   DI-Connect-Wellness/<dates>_<user>_sleepData.json, one entry per night:
     [ { "sleepStartTimestampGMT": "2026-04-11T06:00:00.0",
         "sleepEndTimestampGMT": "2026-04-11T13:25:00.0", "calendarDate": "2026-04-11",
         "deepSleepSeconds": 5400, "lightSleepSeconds": 14880, "remSleepSeconds": 5640,
         "awakeSleepSeconds": 780, "sleepScores": { "overallScore": 81, ... } } ]

   The rest of the folder (daily summaries, profile, personal records) is not
   read yet and still lands as plain files. The original activity files under
   the uploaded-files folder are .fit, which nothing reads; a .gpx among them
   goes to the GPX importer as before.
*/
import fs from 'node:fs';
import path from 'node:path';

import { readJsonFile } from './readers';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

export type GarminExportFileKind = 'activities' | 'sleep';

const ACTIVITIES_RE = /_summarizedActivities\.json$/i;
const SLEEP_RE = /_sleepData\.json$/i;

/** Which export file this is, by name, or undefined when it is none we read. */
export function garminExportFileKind(fpath: string): GarminExportFileKind | undefined {
  const base = path.basename(fpath);

  if (ACTIVITIES_RE.test(base)) {
    return 'activities';
  }

  if (SLEEP_RE.test(base)) {
    return 'sleep';
  }

  return undefined;
}

interface SummarizedActivity {
  activityId?: unknown;
  name?: unknown;
  activityType?: unknown;
  startTimeGmt?: unknown;
  beginTimestamp?: unknown;
  duration?: unknown;
  distance?: unknown;
  avgHr?: unknown;
}

interface SleepNight {
  sleepStartTimestampGMT?: unknown;
  sleepEndTimestampGMT?: unknown;
  calendarDate?: unknown;
  deepSleepSeconds?: unknown;
  lightSleepSeconds?: unknown;
  remSleepSeconds?: unknown;
  awakeSleepSeconds?: unknown;
  sleepScores?: { overallScore?: unknown } | null;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function epochMs(v: unknown): Date | undefined {
  const ms = num(v);
  if (ms === undefined) {
    return undefined;
  }

  const d = new Date(ms);

  return isNaN(d.getTime()) ? undefined : d;
}

// "2026-04-11T06:00:00.0" is GMT but carries no zone, which Date would read as local.
function gmtTimestamp(v: unknown): Date | undefined {
  const s = text(v);
  if (!s) {
    return undefined;
  }

  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`);

  return isNaN(d.getTime()) ? undefined : d;
}

// Milliseconds as the H:MM:SS the Activities.csv "Time" column uses.
function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');

  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

// "running" / "road_biking" as the words Garmin shows ("Running", "Road Biking").
function activityLabel(type: string): string {
  return type
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** The activities in a summarizedActivities file: entries of every `summarizedActivitiesExport` list. */
function activitiesIn(parsed: unknown): unknown[] {
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const out: unknown[] = [];

  for (const block of blocks) {
    const list =
      block && typeof block === 'object'
        ? (block as Record<string, unknown>).summarizedActivitiesExport
        : undefined;
    if (Array.isArray(list)) {
      out.push(...list);
    }
  }

  return out;
}

export async function importGarminExportFile(
  fpath: string,
  kind: GarminExportFileKind,
  params: ImportParams,
): Promise<void> {
  const parsed = await readJsonFile(fpath, { log: params.log });
  if (parsed === undefined) {
    return;
  }

  const base = path.basename(fpath);

  if (kind === 'activities') {
    const activities = activitiesIn(parsed);
    params.pipeline.consumed?.(activities.length);
    activities.forEach((a, index) => pushActivity(a as SummarizedActivity, base, index, params));

    return;
  }

  const nights = Array.isArray(parsed) ? parsed : [];
  params.pipeline.consumed?.(nights.length);
  nights.forEach((n, index) => pushSleep(n as SleepNight, base, index, params));
}

function pushActivity(a: SummarizedActivity, base: string, index: number, params: ImportParams): void {
  if (!a || typeof a !== 'object') {
    params.pipeline.drop?.('malformed_entry', base);

    return;
  }

  const ts = epochMs(a.startTimeGmt) ?? epochMs(a.beginTimestamp);
  if (!ts) {
    params.pipeline.drop?.('garmin_undated_record', base);

    return;
  }

  if (!timeframeContains(params.timeframe, ts)) {
    params.pipeline.drop?.('outside_timeframe');

    return;
  }

  const type = text(a.activityType);
  const activityType = type ? activityLabel(type) : undefined;
  const title = text(a.name) ?? activityType;
  const distanceCm = num(a.distance);
  const durationMs = num(a.duration);
  const avgHr = num(a.avgHr);
  const activityId = num(a.activityId) ?? text(a.activityId);

  params.pipeline.push({
    item: {
      id: activityId !== undefined ? `garmin:activity:${activityId}` : `garmin:${base}:${index}`,
      classification: 'workout',
      timestamp: ts,
      timespanEnd: durationMs !== undefined ? new Date(ts.getTime() + durationMs) : undefined,
      content: textContent('workout.txt', title ?? 'Garmin activity'),
      metadata: {
        // The same keys and units the Activities.csv rows carry.
        'Activity Type': activityType,
        Title: title,
        Distance: distanceCm !== undefined ? (distanceCm / 100_000).toFixed(2) : undefined,
        Time: durationMs !== undefined ? clock(durationMs) : undefined,
        'Avg HR': avgHr !== undefined ? String(Math.round(avgHr)) : undefined,
        Source: 'Garmin Connect',
      },
    },
  });
}

function pushSleep(n: SleepNight, base: string, index: number, params: ImportParams): void {
  if (!n || typeof n !== 'object') {
    params.pipeline.drop?.('malformed_entry', base);

    return;
  }

  const start = gmtTimestamp(n.sleepStartTimestampGMT);
  if (!start) {
    params.pipeline.drop?.('garmin_undated_record', base);

    return;
  }

  if (!timeframeContains(params.timeframe, start)) {
    params.pipeline.drop?.('outside_timeframe');

    return;
  }

  const end = gmtTimestamp(n.sleepEndTimestampGMT);
  const asleepSeconds = [n.deepSleepSeconds, n.lightSleepSeconds, n.remSleepSeconds]
    .map(num)
    .filter((s): s is number => s !== undefined);
  const minutesAsleep = asleepSeconds.length
    ? Math.round(asleepSeconds.reduce((x, y) => x + y, 0) / 60)
    : undefined;
  const awake = num(n.awakeSleepSeconds);
  const date = text(n.calendarDate);
  const summary = `Slept ${minutesAsleep ?? '?'} min` + (date ? ` on ${date}` : '');

  params.pipeline.push({
    item: {
      id: `garmin:sleep:${date ?? `${base}:${index}`}`,
      classification: 'sleep',
      timestamp: start,
      timespanEnd: end,
      content: textContent('sleep.txt', summary),
      metadata: {
        Title: summary,
        'Minutes Asleep': minutesAsleep,
        'Minutes Awake': awake !== undefined ? Math.round(awake / 60) : undefined,
        'Sleep Score': num(n.sleepScores?.overallScore),
        'Date Of Sleep': date,
        Source: 'Garmin Connect',
      },
    },
  });
}

/** Whether `fpath` is a regular file (an export file name on a directory is not ours). */
export async function isRegularFile(fpath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(fpath)).isFile();
  } catch {
    return false;
  }
}
