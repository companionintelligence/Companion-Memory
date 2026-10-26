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

  it('packs two or more loose files that are not archives', () => {
    const photo = file('PXL_001.jpg');
    const video = file('VID_002.mp4');

    expect(splitLooseFiles([photo, video])).toEqual({ pack: [photo, video], single: [] });
  });

  it('keeps every archive on its own, beside the packed rest', () => {
    const partOne = file('takeout-001.zip');
    const photo = file('PXL_001.jpg');
    const partTwo = file('takeout-002.tgz');
    const video = file('VID_002.mp4');

    expect(splitLooseFiles([partOne, photo, partTwo, video])).toEqual({
      pack: [photo, video],
      single: [partOne, partTwo],
    });
  });

  it('leaves a single loose file as it is', () => {
    const contacts = file('contacts.vcf');

    expect(splitLooseFiles([contacts])).toEqual({ pack: [], single: [contacts] });
  });

  it('uploads loose files one by one when together they are too big to pack', () => {
    const big = sized('VID_big.mp4', PACK_LOOSE_FILES_MAX_BYTES);
    const small = sized('PXL_001.jpg', 1);

    expect(splitLooseFiles([big, small])).toEqual({ pack: [], single: [big, small] });
  });
});
