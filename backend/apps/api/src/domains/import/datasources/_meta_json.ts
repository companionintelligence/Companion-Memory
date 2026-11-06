/**
 * JSON-format mojibake repair for Meta "Download Your Information" exports.
 *
 * Facebook AND Instagram DYI JSON files are written by the same exporter, and
 * it serialises all non-ASCII text as raw UTF-8 BYTES, each escaped as a
 * separate \u00XX code point. JSON.parse therefore yields Latin-1 mojibake:
 * "😊" arrives as "ð\u009f\u0098\u008a", "é" as "Ã©". Re-encoding those code
 * points as Latin-1 bytes and decoding them as UTF-8 recovers the original
 * text.
 *
 * Guarded so correct text is never touched: a string with any code point above
 * 0xFF is already real Unicode, and a decode that produces U+FFFD wasn't UTF-8
 * after all — both pass through unchanged. That guard is what makes the repair
 * safe to apply to every Meta JSON file unconditionally.
 *
 * Lived in facebook.ts until 2026-11-05; instagram.ts parsed the same files
 * with a bare JSON.parse and stored every emoji and accent in a DM or caption
 * garbled.
 */
export function fixMojibake(s: string): string {
  if (!/[\u0080-ÿ]/.test(s)) {
    return s;
  } // pure ASCII — nothing to repair

  if (/[Ā-￿]/.test(s)) {
    return s;
  } // already real Unicode (incl. emoji)

  const decoded = Buffer.from(s, 'latin1').toString('utf8');

  return decoded.includes('�') ? s : decoded;
}

/** Repair every string value in a parsed Meta JSON document (keys are ASCII). */
export function fixMojibakeDeep<T>(v: T): T {
  if (typeof v === 'string') {
    return fixMojibake(v) as T;
  }

  if (Array.isArray(v)) {
    return v.map(fixMojibakeDeep) as T;
  }

  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = fixMojibakeDeep(val);
    }

    return out as T;
  }

  return v;
}

/** JSON.parse a Meta DYI file with mojibake repair. Null on invalid JSON. */
export function parseMetaJson<T>(raw: string): T | null {
  try {
    return fixMojibakeDeep(JSON.parse(raw)) as T;
  } catch {
    return null;
  }
}
