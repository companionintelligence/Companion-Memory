/**
 * The coarse kinds a file browse can be narrowed to — the explorer's
 * `?fileKinds=` param and a saved search's `filters.fileKinds`. Mirrors the
 * server's `fileKinds.ts`, which reads them off the file's content type.
 */
export const FILE_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_KIND_LABELS: Record<FileKind, string> = {
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  document: 'Documents',
};

export function fileKindLabel(kind: string): string {
  return (FILE_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export function isFileKind(value: string): value is FileKind {
  return (FILE_KINDS as readonly string[]).includes(value);
}
