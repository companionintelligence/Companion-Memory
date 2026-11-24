import { apiFetch, fetchJson } from '@ci/common';

function authHeaders(authToken: string | null | undefined): HeadersInit {
  return {
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
}

/** Stream-download an NDJSON export without buffering the full archive in memory. */
export async function downloadAccountExport(
  authToken: string | null | undefined,
  filename = 'ci-memory-export.ndjson',
): Promise<void> {
  const response = await fetch('/api/account/export', {
    headers: authHeaders(authToken),
  });

  if (!response.ok) {
    throw new Error(`Export failed (${response.status})`);
  }

  const suggestedName =
    parseContentDispositionFilename(response.headers.get('Content-Disposition')) ?? filename;

  if (typeof window.showSaveFilePicker === 'function') {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: 'CI Memory export',
          accept: { 'application/x-ndjson': ['.ndjson'] },
        },
      ],
    });
    const writable = await handle.createWritable();
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('Export stream unavailable');
    }

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      await writable.write(value);
    }

    await writable.close();

    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Stream-upload an NDJSON export file without reading it all into memory first. */
export async function uploadAccountImport(
  authToken: string | null | undefined,
  file: File,
  confirmEmail: string,
): Promise<{ tablesImported: number; rowsImported: number; filesRestored: number; format: string }> {
  // `apiFetch`, not bare `fetch`: it runs the write guard (an import while the appliance is
  // unreachable is refused up front) and resolves the path against the Memory origin.
  const response = await apiFetch('/api/account/import/stream', {
    method: 'POST',
    headers: {
      ...authHeaders(authToken),
      'Content-Type': 'application/x-ndjson',
      'X-Confirm-Email': confirmEmail.trim(),
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error(`Import failed (${response.status})`);
  }

  const result = await response.json();

  if (!result || typeof result !== 'object') {
    throw new Error('Import returned no result');
  }

  return result as {
    tablesImported: number;
    rowsImported: number;
    filesRestored: number;
    format: string;
  };
}

/** Legacy JSON import for small `.json` archives exported before streaming landed. */
export async function uploadLegacyAccountImport(
  authToken: string | null | undefined,
  file: File,
  confirmEmail: string,
): Promise<{ tablesImported: number; rowsImported: number; filesRestored: number; format: string }> {
  const text = await file.text();
  const archive = JSON.parse(text) as unknown;

  const result = await fetchJson<{
    tablesImported: number;
    rowsImported: number;
    filesRestored: number;
    format: string;
  }>('/api/account/import', {
    method: 'POST',
    headers: {
      ...authHeaders(authToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      confirmEmail: confirmEmail.trim(),
      archive,
    }),
  });

  if (!result) {
    throw new Error('Import returned no result');
  }

  return result;
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) {
    return null;
  }

  const match = /filename="([^"]+)"/.exec(header);

  return match?.[1] ?? null;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<{
      createWritable: () => Promise<{
        write: (chunk: Uint8Array) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  }
}
