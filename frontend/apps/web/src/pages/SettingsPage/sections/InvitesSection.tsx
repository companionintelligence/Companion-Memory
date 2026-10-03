import { useCallback, useEffect, useState } from 'react';

import { apiKeyHeaders, fetchJson, FetchJsonError } from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { Copy } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

interface SignupCode {
  signup_code: string;
  created_at?: string;
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof FetchJsonError ? error.message : fallback;
}

/**
 * Invite someone onto this appliance.
 *
 * `require.signup.codes` ships on, and until now nothing in the product could
 * produce a code — the service existed but no caller did, so the table started
 * empty and stayed empty. The first account is exempt, so a fresh appliance
 * worked; the second had no route in at all, and an OIDC redirect cannot carry
 * a code the way a signup form can. This is the missing half: the owner mints
 * an invitation, and it travels through either path.
 *
 * A code is a way into someone's memory, so it is issued deliberately by a
 * person rather than minted automatically, single-use, and burned the moment it
 * admits someone.
 */
export function InvitesSection() {
  const [{ authToken }] = useAuth();
  const [codes, setCodes] = useState<SignupCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // On the web `apiKeyHeaders()` is empty: a browser session's only credential
  // is its Bearer token, and JwtOrApiKeyAuthGuard reads no other. Sending the
  // API key alone 401'd both calls for the owner, so no invitation could be
  // listed or created from the web. The native app's key still rides along.
  const authHeaders = useCallback(
    (): Record<string, string> => ({
      ...apiKeyHeaders(),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    }),
    [authToken],
  );

  const load = useCallback(async () => {
    try {
      const result = await fetchJson<SignupCode[]>('/api/signup-codes', { headers: authHeaders() });

      setCodes(Array.isArray(result) ? result : []);
      setError(null);
    } catch (err) {
      setError(messageFrom(err, 'Could not load invitations.'));
    }
  }, [authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const mint = async () => {
    setBusy(true);

    try {
      await fetchJson<SignupCode>('/api/signup-codes', { method: 'POST', headers: authHeaders() });
      await load();
      setError(null);
    } catch (err) {
      setError(messageFrom(err, 'Could not create an invitation.'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
    } catch {
      // Clipboard blocked — the code is on screen and selectable anyway.
    }
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title>Invitations</Card.Title>
        <Card.Description>
          Anyone signing in to this Memory after you needs an invitation. Each one works once.
        </Card.Description>
      </Card.Header>

      <Card.Content className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {codes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No unused invitations.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {codes.map((code) => (
              <li key={code.signup_code} className="flex items-center justify-between gap-3">
                <code className="rounded bg-muted px-2 py-1 font-mono text-sm">{code.signup_code}</code>
                <Button variant="ghost" size="sm" onClick={() => void copy(code.signup_code)}>
                  <Copy className="mr-1.5 size-3.5" />
                  {copied === code.signup_code ? 'Copied' : 'Copy'}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <Button onClick={() => void mint()} disabled={busy}>
            {busy ? 'Creating…' : 'Create an invitation'}
          </Button>
        </div>
      </Card.Content>
    </Card>
  );
}
