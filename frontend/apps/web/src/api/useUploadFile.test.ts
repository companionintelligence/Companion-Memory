/**
 * useUploadFile: the file-attach mutation behind Chat uploads and thing
 * capture. Covers the request it builds (multipart body, optional
 * thingCapture/model fields, bearer token), the success/error/loading
 * state machine, and that a fresh upload clears a previous run's leftovers.
 */
import { fetchJson } from '@ci/common';
import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { File as FileData } from './types';
import { useUploadFile } from './useUploadFile';

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'test-token' }],
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: vi.fn(),
}));

const mockedFetchJson = vi.mocked(fetchJson);

function uploadCallBody(): FormData {
  return mockedFetchJson.mock.calls[0][1]?.body as FormData;
}

const RESPONSE_FILE: FileData = {
  id: 'file-1',
  name: 'photo.jpg',
  contentType: 'image/jpeg',
  size: 12345,
};

beforeEach(() => {
  mockedFetchJson.mockReset();
});

describe('useUploadFile — request shape', () => {
  it('POSTs every file under the "files" field, authorized with the bearer token', async () => {
    mockedFetchJson.mockResolvedValue([RESPONSE_FILE]);
    const { result } = renderHook(() => useUploadFile());

    const a = new File(['a'], 'a.jpg');
    const b = new File(['b'], 'b.jpg');

    await act(async () => {
      await result.current[1].upload([a, b]);
    });

    expect(mockedFetchJson).toHaveBeenCalledWith(
      '/api/files/upload',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      }),
    );

    const body = uploadCallBody();
    expect(body.getAll('files')).toEqual([a, b]);
    // Neither optional field was requested, so neither is sent.
    expect(body.has('thingCapture')).toBe(false);
    expect(body.has('model')).toBe(false);
  });

  it('includes thingCapture and model only when passed', async () => {
    mockedFetchJson.mockResolvedValue([]);
    const { result } = renderHook(() => useUploadFile());

    await act(async () => {
      await result.current[1].upload([new File(['a'], 'a.jpg')], {
        thingCapture: true,
        model: 'gpt-vision',
      });
    });

    const body = uploadCallBody();
    expect(body.get('thingCapture')).toBe('true');
    expect(body.get('model')).toBe('gpt-vision');
  });
});

describe('useUploadFile — success', () => {
  it('stores the returned files and reports success', async () => {
    mockedFetchJson.mockResolvedValue([RESPONSE_FILE]);
    const { result } = renderHook(() => useUploadFile());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current[1].upload([new File(['a'], 'a.jpg')]);
    });

    expect(success).toBe(true);
    expect(result.current[0].files).toEqual([RESPONSE_FILE]);
    expect(result.current[0].error).toBeNull();
    expect(result.current[0].loading).toBe(false);
  });

  it('flips loading on for the duration of the request', async () => {
    let release!: (files: FileData[]) => void;
    mockedFetchJson.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const { result } = renderHook(() => useUploadFile());

    let uploadPromise!: Promise<boolean>;
    act(() => {
      uploadPromise = result.current[1].upload([new File(['a'], 'a.jpg')]);
    });

    expect(result.current[0].loading).toBe(true);

    await act(async () => {
      release([RESPONSE_FILE]);
      await uploadPromise;
    });

    expect(result.current[0].loading).toBe(false);
  });

  it('empties a previous run’s files as soon as a new upload starts', async () => {
    mockedFetchJson.mockResolvedValueOnce([RESPONSE_FILE]);
    const { result } = renderHook(() => useUploadFile());

    await act(async () => {
      await result.current[1].upload([new File(['a'], 'a.jpg')]);
    });
    expect(result.current[0].files).toEqual([RESPONSE_FILE]);

    let release!: (files: FileData[]) => void;
    mockedFetchJson.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    act(() => {
      void result.current[1].upload([new File(['b'], 'b.jpg')]);
    });

    // The stale result from run 1 is gone the instant run 2 starts, not left
    // on screen until run 2 resolves.
    expect(result.current[0].files).toEqual([]);

    await act(async () => release([]));
  });
});

describe('useUploadFile — failure', () => {
  it('reports the real error and leaves files empty, without throwing', async () => {
    const uploadError = new Error('413 Payload Too Large');
    mockedFetchJson.mockRejectedValue(uploadError);

    const { result } = renderHook(() => useUploadFile());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current[1].upload([new File(['a'], 'a.jpg')]);
    });

    expect(success).toBe(false);
    expect(result.current[0].error).toBe(uploadError);
    expect(result.current[0].files).toEqual([]);
    expect(result.current[0].loading).toBe(false);
  });

  it('clears a stale error once a new upload succeeds', async () => {
    mockedFetchJson.mockRejectedValueOnce(new Error('nope'));
    const { result } = renderHook(() => useUploadFile());

    await act(async () => {
      await result.current[1].upload([new File(['a'], 'a.jpg')]);
    });
    expect(result.current[0].error).not.toBeNull();

    mockedFetchJson.mockResolvedValueOnce([RESPONSE_FILE]);
    await act(async () => {
      await result.current[1].upload([new File(['a'], 'a.jpg')]);
    });

    expect(result.current[0].error).toBeNull();
    expect(result.current[0].files).toEqual([RESPONSE_FILE]);
  });
});

describe('useUploadFile — reset', () => {
  it('clears files, error and loading back to their initial state', async () => {
    mockedFetchJson.mockRejectedValueOnce(new Error('nope'));
    const { result } = renderHook(() => useUploadFile());

    await act(async () => {
      await result.current[1].upload([new File(['a'], 'a.jpg')]);
    });
    expect(result.current[0].error).not.toBeNull();

    act(() => result.current[1].reset());

    expect(result.current[0].files).toEqual([]);
    expect(result.current[0].error).toBeNull();
    expect(result.current[0].loading).toBe(false);
  });
});
