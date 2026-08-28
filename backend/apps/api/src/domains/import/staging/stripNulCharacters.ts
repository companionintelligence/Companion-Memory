import type { Graph } from '../datasources/timeline';

const NUL = '\u0000';

/**
 * Strip U+0000 from every string a graph carries, before anything reads it.
 *
 * JSON allows `\u0000` and the parsers pass it through faithfully — a real
 * Discord export contained one message with a pasted WebGL shader log, whose
 * NUL terminators Discord had serialized into the message body. Postgres,
 * however, cannot store U+0000 in either `text` or `jsonb`, so the INSERT
 * failed the whole batch (`unsupported Unicode escape sequence`), and because
 * one failed batch fails the source (see StagedWriter.scheduleFlush), every
 * channel after the poisoned one was discarded: one character cost ~2,600 of
 * 13,613 messages.
 *
 * Stripped at push, not at parameter-binding time, so the identity functions
 * (`hashItem`, `entityKey`, `entityIdentityKey`) hash the same bytes the row
 * stores — `identity_key` is itself a text column, so an unsanitized hash
 * input would not even have made it to disk to disagree with.
 *
 * Only U+0000 is removed. Every other control character is legal in Postgres,
 * and staging is deliberately the lane that preserves records as the export
 * had them; the push side already narrows further for its own lanes
 * (push/canonical.ts).
 *
 * Mutates in place. The writer buffers the same object references the parser
 * pushed, so parsers already may not rely on a pushed graph staying untouched,
 * and copying every graph to remove a character almost none of them contain
 * would tax the 40GB import for the one-in-a-million record.
 */
export function stripNulCharacters(graph: Graph): Graph {
  scrub(graph, new WeakSet());

  return graph;
}

function scrub(value: object, seen: WeakSet<object>): void {
  if (seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = scrubbed(value[index], seen);
    }

    return;
  }

  // Dates, Buffers and the lazy `content.data` loader carry no SQL-bound
  // strings; only plain records (metadata trees, items, entities) are walked.
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return;
  }

  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    const cleaned = scrubbed(record[key], seen);

    // jsonb refuses U+0000 in KEY position too, and a parser that put NUL in a
    // value could put it in a key.
    if (key.includes(NUL)) {
      delete record[key];
      record[key.replaceAll(NUL, '')] = cleaned;
    } else {
      record[key] = cleaned;
    }
  }
}

function scrubbed(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value.includes(NUL) ? value.replaceAll(NUL, '') : value;
  }

  if (value != null && typeof value === 'object') {
    scrub(value, seen);
  }

  return value;
}
