/**
 * Split a picker/drop into loose files vs folder trees.
 *
 * A File from `<input webkitdirectory>` or a walked directory drop carries
 * `webkitRelativePath` like `chatgpt-export/conversations.json`. Those belong
 * together as ONE import unit — the same shape the inbox treats as a directory.
 * A zip or a single conversations.json has no slash in that path and stays a
 * per-file drop.
 */

export type ImportBatch =
  { kind: 'file'; files: File[] } | { kind: 'directory'; name: string; files: File[] };

export function relativePathOf(file: File): string {
  return (file.webkitRelativePath || file.name).replace(/\\/g, '/');
}

export function groupImportFiles(files: readonly File[]): ImportBatch[] {
  const trees = new Map<string, File[]>();
  const loose: File[] = [];

  for (const file of files) {
    const relative = relativePathOf(file);
    const slash = relative.indexOf('/');

    if (slash > 0) {
      const root = relative.slice(0, slash);
      const list = trees.get(root) ?? [];

      list.push(file);
      trees.set(root, list);
    } else {
      loose.push(file);
    }
  }

  const batches: ImportBatch[] = [];

  for (const [name, treeFiles] of trees) {
    batches.push({ kind: 'directory', name, files: treeFiles });
  }

  if (loose.length > 0) {
    batches.push({ kind: 'file', files: loose });
  }

  return batches;
}

/**
 * A loose file that is an import on its own: one part of a multi-part export,
 * or a single export archive.
 */
export const ARCHIVE_NAME = /\.(zip|tar|tgz|gz|7z|rar)$/i;

/**
 * The most loose files may add up to and still be packed into one archive.
 *
 * Packing reads every byte once in the tab before the upload starts, and the
 * loose files of a Takeout are the ones too big for any part, so a drop of
 * those could add up past the appliance's 50 GiB upload limit. The files that
 * do not fit go up one at a time, each with its own progress, as every loose
 * file did before packing.
 */
export const PACK_LOOSE_FILES_MAX_BYTES = 4 * 1024 ** 3;

/**
 * Split a drop's loose files into the ones to pack into one archive and the
 * ones that stay a unit each.
 *
 * Archives stay on their own: every part of a multi-part export is a complete
 * archive and gets its own run. Everything else (photos, a contacts file, a
 * JSON export) is a piece of one export, so two or more of them travel as ONE
 * archive and make one run, instead of one run per photo.
 *
 * A loose file's zip entry is its bare name, so two files with the same name
 * (picked from a Recents or search view, or a walked folder whose relative
 * paths the browser would not keep) would be two entries at one path, and
 * unpacking keeps only one of them. Only the first of each name is packed; the
 * others go up on their own, as every loose file did before packing. The
 * match ignores case because the appliance's disk may too.
 *
 * The size budget ({@link PACK_LOOSE_FILES_MAX_BYTES}) is filled smallest
 * first, so one long video in a pick of photos goes up on its own and the
 * photos still make one run, instead of the whole pick falling back to a run
 * per file.
 */
export function splitLooseFiles(files: readonly File[]): { pack: File[]; single: File[] } {
  const candidates: File[] = [];
  const names = new Set<string>();

  for (const file of files) {
    const name = file.name.toLowerCase();

    if (!ARCHIVE_NAME.test(file.name) && !names.has(name)) {
      names.add(name);
      candidates.push(file);
    }
  }

  const packed = new Set<File>();
  let packBytes = 0;

  for (const file of [...candidates].sort((a, b) => a.size - b.size)) {
    if (packBytes + file.size > PACK_LOOSE_FILES_MAX_BYTES) {
      break;
    }

    packed.add(file);
    packBytes += file.size;
  }

  if (packed.size < 2) {
    return { pack: [], single: [...files] };
  }

  return {
    pack: candidates.filter((file) => packed.has(file)),
    single: files.filter((file) => !packed.has(file)),
  };
}
