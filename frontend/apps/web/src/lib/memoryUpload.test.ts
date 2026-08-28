import { fetchJson } from '@ci/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadFilesToMemory } from './memoryUpload';
import { enqueueMemoryUpload, flushMemoryUploadQueue } from './memoryUploadQueue';

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
});
