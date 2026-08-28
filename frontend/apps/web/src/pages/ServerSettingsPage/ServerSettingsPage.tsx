import { type FormEvent, useState } from 'react';

import {
  buildApiUrl,
  getApiBaseUrl,
  isBarcodeScanError,
  isNativePlatform,
  persistApiBaseUrl,
  resolveHttpOrigin,
  scanQrCode,
} from '@ci/common';
import { Button, Card, Input, Label } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { probeMemoryOrigin } from '@/pages/DeviceConnectPage/portal-client';

type Status = 'idle' | 'testing' | 'error';

/**
 * Native-only screen for pointing the app at a self-hosted Companion Memory server.
 * Because the appliance has no single cloud URL, the native client must be told where
 * its Memory Server lives.
 *
 * Product naming: the repo/service is CI-Server, but users never see that name — in the
 * UI it is "Companion Memory" (the product) or "Memory Server" (the box it runs on).
 * Keep new copy on those terms. The entered origin is health-checked before being persisted (via
 * `persistApiBaseUrl`, which stores it in localStorage and applies it for the
 * session). On web this screen is inert — the API origin is always same-origin.
 */
export function ServerSettingsPage() {
  const navigate = useNavigate();

  const [url, setUrl] = useState<string>(() => getApiBaseUrl());
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Parse to a clean http(s) origin, dropping any path/query/hash so the persisted
  // value is always a true origin (e.g. `https://host/app` → `https://host`) and
  // request URLs like `${origin}/api/...` resolve correctly. Returns null if invalid.
  function toOrigin(value: string): string | null {
    try {
      return resolveHttpOrigin(value);
    } catch {
      return null;
    }
  }

  // Scanning only fills in and validates the field — it never health-checks or persists
  // itself. That keeps exactly one code path (handleSubmit, below) responsible for
  // deciding an origin is actually reachable, so a scanned URL gets exactly the same
  // scrutiny as a typed one, and the user gets a chance to see what was scanned (and
  // back out) before anything is saved.
  const handleScan = async () => {
    setScanning(true);
    setStatus('idle');
    setError(null);

    try {
      const raw = await scanQrCode();

      if (raw === null) {
        // User backed out of the scanner, or scanning isn't available here — not an error.
        return;
      }

      const candidate = toOrigin(raw);

      if (!candidate) {
        setStatus('error');
        setError('That QR code did not contain a valid Memory Server URL.');

        return;
      }

      setUrl(candidate);
    } catch (err) {
      setStatus('error');
      setError(
        isBarcodeScanError(err) && err.code === 'denied'
          ? 'Camera access is needed to scan a QR code. Enable it in Settings, or type the URL instead.'
          : 'Could not open the scanner. Try again, or type the URL instead.',
      );
    } finally {
      setScanning(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();

    const candidate = toOrigin(url);

    if (!candidate) {
      setStatus('error');
      setError('Enter a full Memory Server URL, e.g. https://memory.example.com');

      return;
    }

    setStatus('testing');
    setError(null);

    // Probe via native HTTP (same as cloud-connect). WKWebView fetch is CORS-bound
    // and fails with TypeError "Load failed" against a Hub-published appliance.
    try {
      await probeMemoryOrigin(candidate);

      persistApiBaseUrl(candidate);

      // Hand off to the normal flow; the splash route routes to login or feed.
      navigate('/', { replace: true });
    } catch (err) {
      setStatus('error');
      setError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Could not reach your Companion Memory (timed out). Check the URL and your network.'
          : `Could not reach your Companion Memory. ${err instanceof Error ? err.message : ''}`.trim(),
      );
    }
  };

  // buildApiUrl reflects the currently-applied origin, shown as a hint.
  const currentTarget = buildApiUrl('/api');

  return (
    <div className="w-full max-w-sm">
      <Card>
        <Card.Header>
          <Card.Title>Advanced: Memory Server URL</Card.Title>
          <Card.Description>
            Type an origin for a box that is not listed in Portal. Prefer Connect this device when Hub has
            published this Memory Server.
          </Card.Description>
        </Card.Header>

        <Card.Content>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="server-url">Memory Server URL</Label>
              <Input
                id="server-url"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="https://memory.example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={status === 'testing' || scanning}
              />
              <p className="text-muted-foreground text-xs">
                Currently targeting: {currentTarget || '(same origin)'}
              </p>
            </div>

            {isNativePlatform() && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleScan}
                disabled={status === 'testing' || scanning}
              >
                {scanning ? 'Scanning…' : 'Scan QR Code'}
              </Button>
            )}

            {status === 'error' && error && <p className="text-destructive text-sm">{error}</p>}

            <Button type="submit" className="w-full" disabled={status === 'testing' || scanning}>
              {status === 'testing' ? 'Testing…' : 'Test & Connect'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => navigate('/device-connect')}
            >
              Find a server through Portal
            </Button>
          </form>
        </Card.Content>
      </Card>
    </div>
  );
}
