import { BarcodeScanError } from '@ci/common';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerSettingsPage } from './ServerSettingsPage';

/**
 * Native-only "point the app at your Memory Server" screen. A bug here means the app
 * silently talks to the wrong origin — so what matters is: the entered URL is
 * health-checked against `<origin>/api/health` (never against the origin the app is
 * ALREADY configured for), a genuinely reachable origin is persisted and the user is
 * handed off, and an unreachable/invalid one is neither persisted nor silently accepted.
 */

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const h = vi.hoisted(() => ({
  apiBaseUrl: '',
  persistApiBaseUrl: vi.fn(),
  isNativePlatform: vi.fn(() => false),
  scanQrCode: vi.fn(),
}));

// Spread the real module rather than allow-listing exports. This page's health check
// runs through the real `probeMemoryOrigin` (./DeviceConnectPage/portal-client), which
// itself imports `apiFetch` from `@ci/common` — so an allow-list mock blanks a
// dependency the page never names, and every probe throws before reaching `fetch`.
// Only the origin/native helpers are stubbed: the first two so the test drives the
// configured origin, `persistApiBaseUrl` so it is asserted on and never hits
// localStorage, and `isNativePlatform`/`scanQrCode` so the scan button and its
// outcome can be driven per-test (the real `isNativePlatform` is always false in
// jsdom, which would hide the Scan QR Code path entirely). `isBarcodeScanError` is
// left real — it only inspects an error's `name`/`code`, nothing environmental.
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  getApiBaseUrl: () => h.apiBaseUrl,
  buildApiUrl: (path: string) => `${h.apiBaseUrl}${path}`,
  persistApiBaseUrl: h.persistApiBaseUrl,
  isNativePlatform: h.isNativePlatform,
  scanQrCode: h.scanQrCode,
}));

function fillUrl(value: string) {
  fireEvent.change(screen.getByLabelText('Memory Server URL'), { target: { value } });
}

function submit() {
  // Dispatch the `submit` event directly rather than clicking the submit button: the
  // input is `type="url"`, and jsdom (like a real browser) gates a *button-triggered*
  // submission behind its own native constraint validation — a value like "not a url"
  // would never even reach `onSubmit`, silently testing nothing. Submitting the form
  // directly exercises this component's own validation in `toOrigin`, which is what
  // these tests are actually about.
  const form = screen.getByRole('button', { name: /test & connect/i }).closest('form');

  if (!form) {
    throw new Error('submit button is not inside a form');
  }

  fireEvent.submit(form);
}

beforeEach(() => {
  h.apiBaseUrl = '';
  h.persistApiBaseUrl.mockReset();
  h.isNativePlatform.mockReset().mockReturnValue(false);
  h.scanQrCode.mockReset();
  navigate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ServerSettingsPage', () => {
  it('shows the currently configured origin as a hint', () => {
    h.apiBaseUrl = 'https://old.example.com';

    render(<ServerSettingsPage />);

    expect(screen.getByText(/currently targeting: https:\/\/old\.example\.com\/api/i)).toBeInTheDocument();
  });

  it('rejects an unparseable URL before ever making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ServerSettingsPage />);
    fillUrl('not a url');
    submit();

    expect(await screen.findByText(/enter a full memory server url/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.persistApiBaseUrl).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) URL (e.g. a scheme mismatch) without persisting it', async () => {
    render(<ServerSettingsPage />);
    fillUrl('ftp://memory.example.com');
    submit();

    expect(await screen.findByText(/enter a full memory server url/i)).toBeInTheDocument();
    expect(h.persistApiBaseUrl).not.toHaveBeenCalled();
  });

  it('health-checks the CANDIDATE origin (not the already-configured one) before persisting', async () => {
    h.apiBaseUrl = 'https://old.example.com';

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://new.example.com/api/health');

      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ServerSettingsPage />);
    fillUrl('https://new.example.com/some/path?x=1');
    submit();

    await waitFor(() => expect(h.persistApiBaseUrl).toHaveBeenCalledWith('https://new.example.com'));
    // Path/query/hash are stripped — only the clean origin is ever persisted.
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('reports the server status code on an unhealthy response and does not persist or navigate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    render(<ServerSettingsPage />);
    fillUrl('https://down.example.com');
    submit();

    expect(await screen.findByText(/could not reach your companion memory/i)).toBeInTheDocument();
    expect(h.persistApiBaseUrl).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reports a timeout distinctly from a network/connection error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    );
    vi.useFakeTimers();

    render(<ServerSettingsPage />);
    fillUrl('https://slow.example.com');
    submit();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    vi.useRealTimers();

    expect(await screen.findByText(/timed out/i)).toBeInTheDocument();
    expect(h.persistApiBaseUrl).not.toHaveBeenCalled();
  });

  it('disables the form while testing and re-enables it after failure', async () => {
    let resolveFetch: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = () => resolve(new Response(null, { status: 500 }));
          }),
      ),
    );

    render(<ServerSettingsPage />);
    fillUrl('https://memory.example.com');
    submit();

    await waitFor(() => expect(screen.getByRole('button', { name: /testing/i })).toBeDisabled());
    expect(screen.getByLabelText('Memory Server URL')).toBeDisabled();

    resolveFetch?.();

    await waitFor(() => expect(screen.getByRole('button', { name: /test & connect/i })).not.toBeDisabled());
  });

  describe('QR scan (native only)', () => {
    it('hides the scan button on web', () => {
      h.isNativePlatform.mockReturnValue(false);

      render(<ServerSettingsPage />);

      expect(screen.queryByRole('button', { name: /scan qr code/i })).not.toBeInTheDocument();
    });

    it('fills the field with the scanned origin, but does not health-check or persist it', async () => {
      h.isNativePlatform.mockReturnValue(true);
      h.scanQrCode.mockResolvedValue('https://scanned.example.com/some/path?x=1');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      render(<ServerSettingsPage />);
      fireEvent.click(screen.getByRole('button', { name: /scan qr code/i }));

      // Path/query are stripped by the same `toOrigin` the typed-URL path uses.
      await waitFor(() =>
        expect(screen.getByLabelText('Memory Server URL')).toHaveValue('https://scanned.example.com'),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(h.persistApiBaseUrl).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('does nothing when the user cancels the scan (scanQrCode resolves null)', async () => {
      h.isNativePlatform.mockReturnValue(true);
      h.scanQrCode.mockResolvedValue(null);

      render(<ServerSettingsPage />);
      fillUrl('https://unchanged.example.com');
      fireEvent.click(screen.getByRole('button', { name: /scan qr code/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /scan qr code/i })).not.toBeDisabled());
      expect(screen.getByLabelText('Memory Server URL')).toHaveValue('https://unchanged.example.com');
      expect(screen.queryByText(/could not|denied|valid memory server/i)).not.toBeInTheDocument();
    });

    it('shows the same invalid-URL error as a typed URL when the QR payload is not a valid origin', async () => {
      h.isNativePlatform.mockReturnValue(true);
      h.scanQrCode.mockResolvedValue('not a url');

      render(<ServerSettingsPage />);
      fireEvent.click(screen.getByRole('button', { name: /scan qr code/i }));

      expect(await screen.findByText(/did not contain a valid memory server url/i)).toBeInTheDocument();
      expect(h.persistApiBaseUrl).not.toHaveBeenCalled();
    });

    it('shows a clear message on camera-permission denial, distinct from a plain cancel', async () => {
      h.isNativePlatform.mockReturnValue(true);
      h.scanQrCode.mockRejectedValue(
        new BarcodeScanError('Camera access is needed to scan a QR code.', 'denied'),
      );

      render(<ServerSettingsPage />);
      fireEvent.click(screen.getByRole('button', { name: /scan qr code/i }));

      expect(await screen.findByText(/camera access is needed/i)).toBeInTheDocument();
    });

    it('shows a generic scanner error for any other scan failure', async () => {
      h.isNativePlatform.mockReturnValue(true);
      h.scanQrCode.mockRejectedValue(new BarcodeScanError('Could not open the scanner.', 'unavailable'));

      render(<ServerSettingsPage />);
      fireEvent.click(screen.getByRole('button', { name: /scan qr code/i }));

      expect(await screen.findByText(/could not open the scanner/i)).toBeInTheDocument();
    });
  });
});
