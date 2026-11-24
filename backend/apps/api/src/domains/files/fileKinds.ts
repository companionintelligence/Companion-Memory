/**
 * The coarse kinds a file browse can be narrowed to — "just the photos" —
 * read off `ci.files.content_type`'s top-level media type. Shared by the
 * explorer's `fileKinds` filter and a saved search's `filters.fileKinds`.
 *
 * `document` is the remainder: anything that is not a picture, a clip or a
 * recording, including a file whose type was never recorded.
 */
export const FILE_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const MEDIA_PREFIXES: Record<Exclude<FileKind, 'document'>, string> = {
  image: 'image/%',
  video: 'video/%',
  audio: 'audio/%',
};

export function isFileKind(value: unknown): value is FileKind {
  return typeof value === 'string' && (FILE_KINDS as readonly string[]).includes(value);
}

/** The recognised kinds in `values`, deduplicated, or undefined when none are. */
export function normalizeFileKinds(values: readonly string[] | null | undefined): FileKind[] | undefined {
  if (!values) {
    return undefined;
  }

  const kinds = [...new Set(values.filter(isFileKind))];

  return kinds.length > 0 ? kinds : undefined;
}

/**
 * A SQL predicate on `${column}` (a `content_type` column reference, e.g.
 * `file.content_type`) that is true for files of any of `kinds`, with its
 * parameters. Empty `kinds` matches everything.
 */
export function fileKindsPredicate(
  column: string,
  kinds: readonly FileKind[],
): { sql: string; params: Record<string, string> } {
  if (kinds.length === 0) {
    return { sql: '1 = 1', params: {} };
  }

  const clauses: string[] = [];
  const params: Record<string, string> = {};

  for (const kind of kinds) {
    if (kind === 'document') {
      const others = (Object.keys(MEDIA_PREFIXES) as Array<keyof typeof MEDIA_PREFIXES>).map((media) => {
        params[`fileKindNot_${media}`] = MEDIA_PREFIXES[media];

        return `${column} NOT LIKE :fileKindNot_${media}`;
      });

      clauses.push(`(${column} IS NULL OR (${others.join(' AND ')}))`);
    } else {
      params[`fileKind_${kind}`] = MEDIA_PREFIXES[kind];
      clauses.push(`${column} LIKE :fileKind_${kind}`);
    }
  }

  return { sql: `(${clauses.join(' OR ')})`, params };
}
