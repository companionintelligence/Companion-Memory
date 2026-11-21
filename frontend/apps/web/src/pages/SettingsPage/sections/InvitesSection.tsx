import { useCallback, useEffect, useState } from 'react';

import { apiKeyHeaders, fetchJson, FetchJsonError } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Copy } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

import {
  SettingsEmpty,
  SettingsFooter,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from '../kit';

interface SignupCode {
  /** Absent from a server older than invitation expiry; withdrawing needs it. */
  id?: string;
  signup_code: string;
  created_at?: string;
  expires_at?: string;
}

/** "Expires 13 Oct", in the reader's own calendar. */
function expiryLabel(expiresAt: string | undefined): string | null {
  if (!expiresAt) {
    return null;
  }

  const date = new Date(expiresAt);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return `Expires ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
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
 * admits someone. It also stops working after a week, can be withdrawn before
 * anyone uses it, and dies with the account that issued it.
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

  const revoke = async (id: string) => {
    setBusy(true);

    try {
      await fetchJson(`/api/signup-codes/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      await load();
      setError(null);
    } catch (err) {
      setError(messageFrom(err, 'Could not withdraw the invitation.'));
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
    <SettingsSection
      title="Invitations"
      description="Anyone signing in to this Memory after you needs an invitation. Each one works once, and for a week."
    >
      <SettingsGroup>
        {error ? (
          <SettingsRow>
            <SettingsStatus tone="error">{error}</SettingsStatus>
          </SettingsRow>
        ) : null}

        {codes.length === 0 ? (
          <SettingsEmpty title="No unused invitations." />
        ) : (
          codes.map((code) => (
            <SettingsRow
              key={code.signup_code}
              label={<code className="font-mono">{code.signup_code}</code>}
              hint={expiryLabel(code.expires_at) || undefined}
              control={
                <>
                  <Button variant="ghost" onClick={() => void copy(code.signup_code)}>
                    <Copy aria-hidden="true" />
                    {copied === code.signup_code ? 'Copied' : 'Copy'}
                  </Button>
                  {code.id && (
                    <Button
                      variant="ghost"
                      onClick={() => void revoke(code.id!)}
                      disabled={busy}
                      aria-label={`Withdraw invitation ${code.signup_code}`}
                    >
                      Withdraw
                    </Button>
                  )}
                </>
              }
            />
          ))
        )}

        <SettingsFooter>
          <Button onClick={() => void mint()} disabled={busy}>
            {busy ? 'Creating…' : 'Create an invitation'}
          </Button>
        </SettingsFooter>
      </SettingsGroup>
    </SettingsSection>
  );
}
