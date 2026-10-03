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
