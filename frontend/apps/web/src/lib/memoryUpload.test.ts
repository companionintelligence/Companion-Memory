import { fetchJson } from '@ci/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadFilesToMemory } from './memoryUpload';
import {
  enqueueMemoryUpload,
  flushMemoryUploadQueue,
  getPersistedUploadQueueCount,
  rehydrateMemoryUploadQueue,
} from './memoryUploadQueue';

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    fetchJson: vi.fn(),
    hasNotificationPermission: vi.fn(async () => false),
    scheduleLocalNotification: vi.fn(async () => false),
  };
});

const mockedFetchJson = vi.mocked(fetchJson);

describe('uploadFilesToMemory', () => {
  beforeEach(() => {
    mockedFetchJson.mockReset();
    mockedFetchJson.mockResolvedValue([]);
  });

  it('POSTs files as multipart without requiring a chat thread', async () => {
    const file = new File(['a'], 'note.m4a', { type: 'audio/mp4' });

    await uploadFilesToMemory([file], { authToken: 'tok' });

    expect(mockedFetchJson).toHaveBeenCalledWith(
      '/api/files/upload',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
      }),
    );

    const body = mockedFetchJson.mock.calls[0][1]?.body as FormData;
    expect(body.getAll('files')).toEqual([file]);
    expect(body.has('thingCapture')).toBe(false);
    expect(body.has('inventoryCapture')).toBe(false);
  });

  it('marks a Capture-sheet save as a memory capture so the server catalogues it as content', async () => {
    await uploadFilesToMemory([new File(['a'], 'IMG.jpg', { type: 'image/jpeg' })], { memoryCapture: true });

    const body = mockedFetchJson.mock.calls[0][1]?.body as FormData;
    expect(body.get('memoryCapture')).toBe('true');
    expect(body.has('capturedAt')).toBe(false);
  });

  it('sends the device capture moment only alongside a memory capture', async () => {
    await uploadFilesToMemory([new File(['a'], 'AUD.m4a', { type: 'audio/mp4' })], {
      memoryCapture: true,
      capturedAt: '2026-10-14T22:46:00.000Z',
    });
    await uploadFilesToMemory([new File(['a'], 'AUD.m4a', { type: 'audio/mp4' })], {
      capturedAt: '2026-10-14T22:46:00.000Z',
    });

    const captured = mockedFetchJson.mock.calls[0][1]?.body as FormData;
    const plain = mockedFetchJson.mock.calls[1][1]?.body as FormData;
    expect(captured.get('capturedAt')).toBe('2026-10-14T22:46:00.000Z');
    expect(plain.has('capturedAt')).toBe(false);
  });

  it('omits Authorization when there is no session token (native API key path)', async () => {
    await uploadFilesToMemory([new File(['a'], 'a.jpg')]);

    expect(mockedFetchJson.mock.calls[0][1]?.headers).toEqual({});
  });
});

describe('enqueueMemoryUpload', () => {
  beforeEach(() => {
    mockedFetchJson.mockReset();
  });

  it('runs uploads one after another so a closed Capture screen cannot drop the queue', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;

    mockedFetchJson.mockImplementation(async (_url, init) => {
      const body = init?.body as FormData;
      const file = body.get('files') as File;

      if (file.name === 'first.jpg') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }

      order.push(file.name);

      return [];
    });

    const first = enqueueMemoryUpload([new File(['a'], 'first.jpg')]);
    const second = enqueueMemoryUpload([new File(['b'], 'second.jpg')]);

    await vi.waitFor(() => expect(typeof releaseFirst).toBe('function'));
    expect(order).toEqual([]);

    releaseFirst();
    await Promise.all([first, second]);
    await flushMemoryUploadQueue();

    expect(order).toEqual(['first.jpg', 'second.jpg']);
  });

  it('persists queued uploads in localStorage while in-flight and rehydrates interrupted jobs on startup', async () => {
    window.localStorage.clear();
    let releaseUpload!: () => void;

    mockedFetchJson.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });

      return [];
    });

    const pending = enqueueMemoryUpload([new File(['hello'], 'offline.txt', { type: 'text/plain' })], {
      memoryCapture: true,
    });

    await vi.waitFor(() => expect(getPersistedUploadQueueCount()).toBe(1));
    releaseUpload();
    await pending;
    await flushMemoryUploadQueue();

    // Cleared from localStorage once upload completes
    expect(getPersistedUploadQueueCount()).toBe(0);

    // Simulate an interrupted job left in localStorage before page reload
    window.localStorage.setItem(
      'ci.memoryUploadQueue.v1',
      JSON.stringify([
        {
          id: 'upload-interrupted-1',
          createdAt: '2026-10-20T00:00:00.000Z',
          options: { memoryCapture: true },
          files: [
            {
              name: 'recovered.txt',
              type: 'text/plain',
              lastModified: 1700000000000,
              base64: btoa('recovered-bytes'),
            },
          ],
        },
      ]),
    );

    mockedFetchJson.mockResolvedValueOnce([]);
    const rehydrated = await rehydrateMemoryUploadQueue('tok-rehydrate');
    expect(rehydrated).toHaveLength(1);
    expect(getPersistedUploadQueueCount()).toBe(0);
  });
});
