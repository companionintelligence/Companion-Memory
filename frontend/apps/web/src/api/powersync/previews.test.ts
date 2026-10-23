import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { convertFileSrc: (uri: string) => `http://localhost/_capacitor_file_${uri}` },
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: { getUri: async () => ({ uri: 'file:///data/user/0/com.ci.memory/files/' }) },
}));

import {
  isPreviewSyncEnabled,
  ledgerRow,
  PREVIEW_SYNC_STORAGE_KEY,
  previewApiPath,
  previewPath,
  previewSrc,
  reconcileIds,
  setPreviewSyncEnabled,
  subscribePreviewSync,
} from './previews';

afterEach(() => localStorage.removeItem(PREVIEW_SYNC_STORAGE_KEY));

describe('the preview setting', () => {
  it('is on until turned off, and tells its subscribers either way', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribePreviewSync(() => seen.push(isPreviewSyncEnabled()));

    expect(isPreviewSyncEnabled()).toBe(true);
    setPreviewSyncEnabled(false);
    expect(isPreviewSyncEnabled()).toBe(false);
    setPreviewSyncEnabled(true);
    expect(seen).toEqual([false, true]);

    unsubscribe();
    setPreviewSyncEnabled(false);
    expect(seen).toEqual([false, true]);
  });
});

describe('the ledger', () => {
  it('names each preview by the original file id, under the previews directory, through the API', () => {
    expect(previewPath('f1')).toBe('previews/f1.jpg');
    expect(previewApiPath('f 1')).toBe('/api/files/f%201/preview');
    // id, timestamp, filename, local_uri, media_type, size, state (2 = queued for download)
    expect(ledgerRow('f1', 123)).toEqual(['f1', 123, 'f1.jpg', null, 'image/jpeg', null, 2]);
  });

  it('reconciles the ids the replica names against the rows it holds, with sets', () => {
    expect(reconcileIds(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({ missing: ['a'], orphaned: ['d'] });
    expect(reconcileIds([], ['x'])).toEqual({ missing: [], orphaned: ['x'] });
    expect(reconcileIds(['x'], [])).toEqual({ missing: ['x'], orphaned: [] });
  });

  it("serves a file through Capacitor's file scheme, under the app's data directory", async () => {
    expect(await previewSrc('previews/f1.jpg')).toBe(
      'http://localhost/_capacitor_file_file:///data/user/0/com.ci.memory/files/previews/f1.jpg',
    );
  });
});
