import { type FormEvent, useState } from 'react';

import { buildApiUrl, getApiBaseUrl, persistApiBaseUrl } from '@ci/common';
import { Button, Card, Input, Label } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

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

  // Parse to a clean http(s) origin, dropping any path/query/hash so the persisted
  // value is always a true origin (e.g. `https://host/app` → `https://host`) and
  // request URLs like `${origin}/api/...` resolve correctly. Returns null if invalid.
  function toOrigin(value: string): string | null {
    try {
      const parsed = new URL(value.trim());

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      return parsed.origin;
    } catch {
      return null;
    }
  }

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

    // Health-check the candidate origin directly (not via buildApiUrl, since we are
    // validating a URL the user has not committed to yet). `/api/health` is
    // unauthenticated, so a 2xx confirms reachability before we save.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(`${candidate}/api/health`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Memory Server responded with ${response.status}`);
      }

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
    } finally {
      // Always clear the abort timer, including the network-error path.
      clearTimeout(timeout);
    }
  };

  // buildApiUrl reflects the currently-applied origin, shown as a hint.
  const currentTarget = buildApiUrl('/api');

  return (
    <div className="w-full max-w-sm">
      <Card>
        <Card.Header>
          <Card.Title>Connect to your Companion Memory</Card.Title>
          <Card.Description>Enter the address of your Memory Server.</Card.Description>
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
                disabled={status === 'testing'}
              />
              <p className="text-muted-foreground text-xs">
                Currently targeting: {currentTarget || '(same origin)'}
              </p>
            </div>

            {status === 'error' && error && <p className="text-destructive text-sm">{error}</p>}

            <Button type="submit" className="w-full" disabled={status === 'testing'}>
              {status === 'testing' ? 'Testing…' : 'Test & Connect'}
            </Button>
          </form>
        </Card.Content>
      </Card>
    </div>
  );
}
