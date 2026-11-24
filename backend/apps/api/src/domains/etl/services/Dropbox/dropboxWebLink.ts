import path from 'node:path';

/**
 * Where a person opens this file in Dropbox's web app. A listing carries no
 * link of its own (a shared link would have to be CREATED, which changes the
 * file's sharing), so this is the folder view with the file previewed.
 *
 * Also the pointer row's `external_id`, which is why it lives apart from the
 * transform: the folder-export ingest rebuilds the same string to find the
 * pointer rows of files it has since imported.
 */
export function dropboxWebLink(file: { path_display?: string; name: string }): string | null {
  if (!file.path_display) {
    return null;
  }

  const folder = path.posix.dirname(file.path_display);
  const encodedFolder = folder === '/' ? '' : folder.split('/').map(encodeURIComponent).join('/');

  return `https://www.dropbox.com/home${encodedFolder}?preview=${encodeURIComponent(file.name)}`;
}
