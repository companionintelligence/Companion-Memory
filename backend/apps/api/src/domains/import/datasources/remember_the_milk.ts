/* Remember the Milk — account "Download Export" JSON.
 *
 * Getting the file: RTM's own Help Center (rememberthemilk.com/help/answer/
 * accounts-backup and .../basics-tasks-importexport-export, fetched 2026-08-21)
 * describes a single self-serve export: Settings gear -> Account settings ->
 * Export -> "Download Export", producing a '.json' file — "the option you
 * should choose to keep an archive for your records, or use the data in
 * another service." A parallel iCalendar link exists but is explicitly called
 * out as "more limited than the JSON format," so JSON is the one worth a real
 * parser. The import side of the same help pair (.../basics-tasks-importexport-
 * import) confirms the round-trip: "select the Remember The Milk '.json' file
 * from your computer," and that re-importing it won't duplicate "Lists, Smart
 * Lists, tags, locations, and sorting options that already exist" — i.e. the
 * export is a real account snapshot, not just a task list.
 *
 * Neither help page prints the file's actual field names, and RTM does not
 * publish a schema for it (a user asking on RTM's own forum for the JSON
 * layout got no documentation back — rememberthemilk.com/forums/help/31522/,
 * "I saw that it was possible to import in JSON format... couldn't find
 * anything about the layout of the JSON file"). The one place the real
 * shape surfaces is a small, working, third-party script that reads an
 * actually-downloaded export: github.com/feoh/forgetthemilk
 * (forgetthemilk.py — CLI help text literally says its input is "The JSON
 * file you exported from Remember The Milk"). What that script does with the
 * file is exactly two things, and they are the two things this parser also
 * relies on:
 *
 *   tasks = rtm_json['tasks']                       # top-level 'tasks' array
 *   open_tasks = [t for t in tasks if 'date_completed' not in t]   # per-task
 *   row_task['name']                                 # ... 'name' field
 *
 * i.e. a flat `{ "tasks": [ { "name": "...", "date_completed"?: "..." }, ... ] }`
 * — NOT the nested list/taskseries/task tree RTM's *API* returns from
 * rtm.tasks.getList (services/api/methods/rtm.tasks.getList.rtm). That API
 * shape describes a different surface (a live API pull) and this export
 * disagrees with it in the one place a real downloaded file was actually
 * read, so it is deliberately not assumed here.
 *
 * RTM staff and users describing the file on the "BACKUP" forum thread
 * (rememberthemilk.com/forums/help/22833/) add that it also carries "a few
 * account settings" ahead of the tasks, and that notes and completed/
 * incomplete/dated/undated tasks are all included — but nobody in that thread
 * quotes actual key names for any of that, so this parser does not read notes,
 * due dates, tags, priority, or list membership: none of those field names are
 * confirmed by a real citation. What's here is deliberately narrower than the
 * full RTM data model — see the module comment in guides.ts on why a guessed
 * field is worse than an absent one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

/**
 * One element of the confirmed top-level `tasks` array. Only `name` and
 * `date_completed` are attested (see module comment) — everything else in a
 * real file is read defensively, if at all, and never required.
 */
interface RtmTask {
  name?: unknown;
  date_completed?: unknown;
}

interface RtmExport {
  tasks?: unknown;
}

/** RTM stamps completion timestamps as ISO-8601 strings in every dated surface
 *  this session could confirm (the API docs' example `completed="2015-05-07T…Z"`
 *  attribute). Parsed defensively: an unparsable value still means "completed",
 *  it just can't supply a timestamp. */
function parseRtmDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw.trim()) {
    return undefined;
  }

  const d = new Date(raw.trim());

  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Structural sniff for the one shape this session could actually confirm: a
 * JSON object with a top-level `tasks` array whose entries are objects
 * carrying a string `name`. Sampling (not just the first element) guards
 * against a coincidentally task-shaped first entry in an unrelated export.
 */
function sniffExport(obj: unknown): RtmTask[] | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return undefined;
  }

  const tasks = (obj as RtmExport).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return undefined;
  }

  const sample = tasks.slice(0, 10);
  const nameBearing = sample.filter(
    (t) => t && typeof t === 'object' && typeof (t as RtmTask).name === 'string',
  );

  // Require every sampled entry to look like a task — one stray non-task
  // element in the first ten is enough to say this isn't the shape.
  if (nameBearing.length !== sample.length) {
    return undefined;
  }

  return tasks as RtmTask[];
}

async function sniffFile(fpath: string): Promise<RtmTask[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(fpath, 'utf8');
  } catch {
    return undefined;
  }

  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  return sniffExport(parsed);
}

// A generic-looking hint in the filename/dropped-folder name — RTM's own help
// pages never print the literal downloaded filename, so this only ever raises
// confidence on top of a real structural match; it is never required.
function looksLikeRtmName(name: string): boolean {
  const n = name.toLowerCase();

  return n.includes('milk') || n.includes('rtm') || n.includes('remember');
}

export class RememberTheMilkFileImporter implements FileImporter {
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

    if (st.isFile()) {
      if (path.extname(root).toLowerCase() !== '.json') {
        return { confidence: 0 };
      }

      const tasks = await sniffFile(root);
      if (!tasks) {
        return { confidence: 0 };
      }

      return { confidence: looksLikeRtmName(path.basename(root)) ? 0.9 : 0.75 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.json') {
            continue;
          }

          const tasks = await sniffFile(path.join(root, name));
          if (tasks) {
            const hint = looksLikeRtmName(name) || looksLikeRtmName(path.basename(root));

            return { confidence: hint ? 0.9 : 0.75, dir_threshold: 0.7 };
          }
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

    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      return;
    }

    const files: string[] = [];
    if (st.isFile()) {
      files.push(root);
    } else if (st.isDirectory()) {
      for (const name of fs.readdirSync(root).sort((a, b) => a.localeCompare(b))) {
        if (path.extname(name).toLowerCase() === '.json') {
          files.push(path.join(root, name));
        }
      }
    }

    for (const fpath of files) {
      await this.processFile(fpath, params);
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    const tasks = await sniffFile(fpath);
    if (!tasks) {
      // Not actually an RTM export (e.g. reached directly rather than via
      // recognize()) — say nothing rather than throw on someone else's JSON.
      return;
    }

    tasks.forEach((task, i) => {
      try {
        this.pushTask(task, i, base, params);
      } catch (e) {
        params.log?.('error', `Failed to import a task in ${base}`, { error: (e as Error).message });
      }
    });
  }

  private pushTask(task: RtmTask, index: number, base: string, params: ImportParams): void {
    const name = typeof task.name === 'string' ? task.name.trim() : '';
    if (!name) {
      return;
    }

    // Presence of `date_completed` is the confirmed completion signal
    // (forgetthemilk.py: `'date_completed' not in t`); its value, when present
    // and parsable, doubles as the completion timestamp.
    const hasCompletedKey = task.date_completed !== undefined;
    const completedAt = hasCompletedKey ? parseRtmDate(task.date_completed) : undefined;
    const ts = completedAt;

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // No task id is confirmed by any cited source, so the id is derived from
    // content plus position — stable across re-imports of the same file
    // (content and index don't change) without inventing a field.
    const id =
      'remember_the_milk:' +
      crypto
        .createHash('sha1')
        .update(`${base}\0${index}\0${name}\0${String(task.date_completed ?? '')}`)
        .digest('hex');

    params.pipeline.push({
      item: {
        id,
        classification: 'note',
        timestamp: ts,
        content: { filename: 'task.txt', mediaType: 'text/plain', data: async () => Buffer.from(name) },
        metadata: {
          Title: name,
          Completed: hasCompletedKey,
          Source: 'Remember the Milk',
        },
      },
    });
  }
}

registerDataSource({
  name: 'remember_the_milk',
  title: 'Remember the Milk',
  icon: '',
  description: 'Tasks from a Remember the Milk account JSON export.',
  newFileImporter: () => new RememberTheMilkFileImporter(),
});
