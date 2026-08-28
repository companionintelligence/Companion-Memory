import { fetchJson } from '@ci/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadAccountExport,
  uploadAccountImport,
  uploadLegacyAccountImport,
} from './accountDataPortability';

// Only `fetchJson` is used by this module (the legacy import path); the streamed
// export/import paths below go straight through the global `fetch`.
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: vi.fn(),
}));

const mockedFetchJson = vi.mocked(fetchJson);

type Header = Record<string, string>;

function headersFrom(headers: Header) {
  return { get: (name: string) => headers[name] ?? null };
}

function okBlobResponse(headers: Header, blob: Blob): Response {
  return {
    ok: true,
    status: 200,
    headers: headersFrom(headers),
    blob: async () => blob,
  } as unknown as Response;
}

function okStreamResponse(headers: Header, chunks: Uint8Array[]): Response {
  let i = 0;

  return {
    ok: true,
    status: 200,
    headers: headersFrom(headers),
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            const value = chunks[i];

            i += 1;

            return { done: false, value };
          }

          return { done: true, value: undefined };
        },
      }),
    },
  } as unknown as Response;
}

function failedResponse(status: number): Response {
  return { ok: false, status, headers: headersFrom({}) } as unknown as Response;
}

function okJsonResponse(body: unknown): Response {
  return { ok: true, status: 200, headers: headersFrom({}), json: async () => body } as unknown as Response;
}

const IMPORT_RESULT = { tablesImported: 3, rowsImported: 900, filesRestored: 2, format: 'ndjson' };

let clickSpy: ReturnType<typeof vi.fn>;
let originalAnchorClick: () => void;

beforeEach(() => {
  clickSpy = vi.fn();
  originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = clickSpy;

  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:mock-export-url'),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  HTMLAnchorElement.prototype.click = originalAnchorClick;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'showSaveFilePicker');
});

describe('downloadAccountExport', () => {
  it('throws a status-bearing error when the export request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failedResponse(401)),
    );

    await expect(downloadAccountExport('bad-token')).rejects.toThrow(/401/);
  });

  it('sends the bearer token and omits Authorization when there is none', async () => {
    const fetchMock = vi.fn(async () => okBlobResponse({}, new Blob(['ndjson'])));
    vi.stubGlobal('fetch', fetchMock);

    await downloadAccountExport('jwt-abc');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/account/export');
    expect((init.headers as Header).Authorization).toBe('Bearer jwt-abc');

    fetchMock.mockClear();
    await downloadAccountExport(null);

    const [, initNoAuth] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((initNoAuth.headers as Header | undefined)?.Authorization).toBeUndefined();
  });

  it('streams straight to disk via the File System Access API when the browser offers it', async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"table":"a"}\n'), encoder.encode('{"table":"b"}\n')];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okStreamResponse({ 'Content-Disposition': 'attachment; filename="custom.ndjson"' }, chunks),
      ),
    );

    const write = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }));

    (window as unknown as { showSaveFilePicker: typeof showSaveFilePicker }).showSaveFilePicker =
      showSaveFilePicker;

    await downloadAccountExport('jwt-abc');

    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'custom.ndjson' }),
    );
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(1, chunks[0]);
    expect(write).toHaveBeenNthCalledWith(2, chunks[1]);
    expect(close).toHaveBeenCalledTimes(1);

    // This is the streamed path — the Blob-download fallback must not also run.
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('falls back to a Blob download using the default filename when neither the picker API nor a filename header is available', async () => {
    const blob = new Blob(['ndjson-body']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okBlobResponse({}, blob)),
    );

    await downloadAccountExport('jwt-abc');

    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-export-url');
  });

  it('raises rather than silently downloading nothing when the picker path gets a bodyless response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => ({ ok: true, status: 200, headers: headersFrom({}), body: null }) as unknown as Response,
      ),
    );

    (window as unknown as { showSaveFilePicker: () => Promise<unknown> }).showSaveFilePicker = vi.fn(
      async () => ({ createWritable: async () => ({ write: vi.fn(), close: vi.fn() }) }),
    );

    await expect(downloadAccountExport('jwt-abc')).rejects.toThrow(/stream unavailable/i);
  });
});

describe('uploadAccountImport (streamed NDJSON)', () => {
  it('posts the raw file with a trimmed confirmation email and returns the parsed result', async () => {
    const fetchMock = vi.fn(async () => okJsonResponse(IMPORT_RESULT));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['{"a":1}\n'], 'export.ndjson', { type: 'application/x-ndjson' });

    const result = await uploadAccountImport('jwt-abc', file, '  user@example.com  ');

    expect(result).toEqual(IMPORT_RESULT);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/account/import/stream');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);

    const headers = init.headers as Header;
    expect(headers.Authorization).toBe('Bearer jwt-abc');
    expect(headers['Content-Type']).toBe('application/x-ndjson');
    // Trimmed — a copy-pasted email with surrounding whitespace must not silently
    // fail the server's confirmation check.
    expect(headers['X-Confirm-Email']).toBe('user@example.com');
  });

  it('surfaces a status-bearing error on a rejected import, without pretending it succeeded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failedResponse(413)),
    );

    const file = new File(['{}'], 'export.ndjson');

    await expect(uploadAccountImport(null, file, 'user@example.com')).rejects.toThrow(/413/);
  });

  it('treats an empty response body as a failure rather than reporting a phantom success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJsonResponse(null)),
    );

    const file = new File(['{}'], 'export.ndjson');

    await expect(uploadAccountImport(null, file, 'user@example.com')).rejects.toThrow(/no result/i);
  });
});

// jsdom's `File`/`Blob` implementation in this test environment does not implement
// `.text()` (verified: `typeof new File([...]).text === 'undefined'`), which is the only
// method `uploadLegacyAccountImport` calls on the file. A minimal object exposing just
// that method — real `File` behavior for every purpose this module actually exercises —
// stands in for it rather than skipping this code path.
function textFile(content: string): File {
  return { text: async () => content } as unknown as File;
}

describe('uploadLegacyAccountImport (JSON archive)', () => {
  it('parses the archive, posts it with a trimmed confirmation email, and returns the result', async () => {
    mockedFetchJson.mockResolvedValue(IMPORT_RESULT);

    const archive = { tables: { notes: [{ id: '1' }] } };
    const file = textFile(JSON.stringify(archive));

    const result = await uploadLegacyAccountImport('jwt-abc', file, '  user@example.com  ');

    expect(result).toEqual(IMPORT_RESULT);

    const [url, init] = mockedFetchJson.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/account/import');
    expect(init.method).toBe('POST');

    const headers = init.headers as Header;
    expect(headers.Authorization).toBe('Bearer jwt-abc');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string) as { confirmEmail: string; archive: unknown };
    expect(body.confirmEmail).toBe('user@example.com');
    expect(body.archive).toEqual(archive);
  });

  it('rejects a file that is not valid JSON rather than sending a broken archive', async () => {
    const file = textFile('{not valid json');

    await expect(uploadLegacyAccountImport(null, file, 'user@example.com')).rejects.toThrow(SyntaxError);
    expect(mockedFetchJson).not.toHaveBeenCalled();
  });

  it('treats a falsy result as a failure rather than reporting a phantom success', async () => {
    mockedFetchJson.mockResolvedValue(undefined);

    const file = textFile('{}');

    await expect(uploadLegacyAccountImport(null, file, 'user@example.com')).rejects.toThrow(/no result/i);
  });
});
