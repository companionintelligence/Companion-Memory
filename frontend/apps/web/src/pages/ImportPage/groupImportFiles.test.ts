import { describe, expect, it } from 'vitest';

import { groupImportFiles, PACK_LOOSE_FILES_MAX_BYTES, splitLooseFiles } from './groupImportFiles';

function file(name: string, relativePath = ''): File {
  const blob = new File(['x'], name);

  if (relativePath) {
    Object.defineProperty(blob, 'webkitRelativePath', { value: relativePath });
  }

  return blob;
}

describe('groupImportFiles', () => {
  it('keeps loose zips as one file batch', () => {
    const zip = file('export.zip');

    expect(groupImportFiles([zip])).toEqual([{ kind: 'file', files: [zip] }]);
  });

  it('groups a folder tree by its first path segment', () => {
    const conversations = file('conversations.json', 'chatgpt-export/conversations.json');
    const html = file('chat.html', 'chatgpt-export/chat.html');

    expect(groupImportFiles([conversations, html])).toEqual([
      { kind: 'directory', name: 'chatgpt-export', files: [conversations, html] },
    ]);
  });

  it('keeps two dropped folders as two directory batches', () => {
    const a = file('a.json', 'one/a.json');
    const b = file('b.json', 'two/b.json');
    const batches = groupImportFiles([a, b]);

    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => (batch.kind === 'directory' ? batch.name : ''))).toEqual(['one', 'two']);
  });

  it('splits a folder drop that also includes a loose zip', () => {
    const tree = file('conversations.json', 'chatgpt-export/conversations.json');
    const zip = file('photos.zip');
    const batches = groupImportFiles([tree, zip]);

    expect(batches).toEqual([
      { kind: 'directory', name: 'chatgpt-export', files: [tree] },
      { kind: 'file', files: [zip] },
    ]);
  });
});

describe('splitLooseFiles', () => {
  function sized(name: string, size: number): File {
    const blob = file(name);

    Object.defineProperty(blob, 'size', { value: size });

    return blob;
  }

  // By name, not toEqual on the Files: toEqual finds any two File objects
  // equal, so it would pass with the pack and the singles swapped.
  function split(files: File[]): { pack: string[]; single: string[] } {
    const { pack, single } = splitLooseFiles(files);

    return { pack: pack.map((entry) => entry.name), single: single.map((entry) => entry.name) };
  }

  it('packs two or more loose files that are not archives', () => {
    const photo = file('PXL_001.jpg');
    const video = file('VID_002.mp4');

    expect(split([photo, video])).toEqual({ pack: ['PXL_001.jpg', 'VID_002.mp4'], single: [] });
  });

  it('keeps every archive on its own, beside the packed rest', () => {
    const partOne = file('takeout-001.zip');
    const photo = file('PXL_001.jpg');
    const partTwo = file('takeout-002.tgz');
    const video = file('VID_002.mp4');

    expect(split([partOne, photo, partTwo, video])).toEqual({
      pack: ['PXL_001.jpg', 'VID_002.mp4'],
      single: ['takeout-001.zip', 'takeout-002.tgz'],
    });
  });

  it('packs only the first of two files with the same name, so unpacking cannot overwrite one', () => {
    const first = file('IMG_0001.JPG');
    const other = file('VID_002.mp4');
    const sameName = file('img_0001.jpg');

    expect(split([first, other, sameName])).toEqual({
      pack: ['IMG_0001.JPG', 'VID_002.mp4'],
      single: ['img_0001.jpg'],
    });
  });

  it('leaves a single loose file as it is', () => {
    const contacts = file('contacts.vcf');

    expect(split([contacts])).toEqual({ pack: [], single: ['contacts.vcf'] });
  });

  it('uploads loose files one by one when no two of them fit the budget together', () => {
    const big = sized('VID_big.mp4', PACK_LOOSE_FILES_MAX_BYTES);
    const small = sized('PXL_001.jpg', 1);

    expect(split([big, small])).toEqual({ pack: [], single: ['VID_big.mp4', 'PXL_001.jpg'] });
  });

  it('packs the photos and sends only the video that does not fit on its own', () => {
    const photoOne = sized('PXL_001.jpg', 5 * 1024 ** 2);
    const video = sized('VID_long.mp4', PACK_LOOSE_FILES_MAX_BYTES - 1024 ** 2);
    const photoTwo = sized('PXL_002.jpg', 5 * 1024 ** 2);

    expect(split([photoOne, video, photoTwo])).toEqual({
      pack: ['PXL_001.jpg', 'PXL_002.jpg'],
      single: ['VID_long.mp4'],
    });
  });
});
