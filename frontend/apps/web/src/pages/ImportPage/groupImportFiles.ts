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
const ARCHIVE_NAME = /\.(zip|tar|tgz|gz|7z|rar)$/i;

/**
 * The most loose files may add up to and still be packed into one archive.
 *
 * Packing reads every byte once in the tab before the upload starts, and the
 * loose files of a Takeout are the ones too big for any part, so a drop of
 * those could add up past the appliance's 50 GiB upload limit. Above this they
 * go up one at a time, each with its own progress, as they always did.
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
 */
export function splitLooseFiles(files: readonly File[]): { pack: File[]; single: File[] } {
  const rest = files.filter((file) => !ARCHIVE_NAME.test(file.name));
  const restBytes = rest.reduce((sum, file) => sum + file.size, 0);

  if (rest.length < 2 || restBytes > PACK_LOOSE_FILES_MAX_BYTES) {
    return { pack: [], single: [...files] };
  }

  return { pack: rest, single: files.filter((file) => ARCHIVE_NAME.test(file.name)) };
}
