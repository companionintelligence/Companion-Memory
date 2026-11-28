import { useEffect, useState, type FormEvent } from 'react';

import { fetchJson } from '@ci/common';
import { Button, PasswordInput } from '@ci/shadcn';

import { SettingsForm, SettingsGroup, SettingsRow, SettingsStatus } from '../kit';

import { messageFrom } from './accountMessages';

/** What the Portal round trip came back with (`OidcController.finishCompanionLink`), as a message. */
const RETURN_MESSAGES: Record<string, { tone: 'success' | 'error'; text: string }> = {
  connected: { tone: 'success', text: 'Companion account connected. You can sign in with it from now on.' },
  linked_elsewhere: {
    tone: 'error',
    text: 'That Companion account already signs in to another account on this Memory, so it was not connected.',
  },
  expired: {
    tone: 'error',
    text: 'Connecting took too long, or this browser signed out meanwhile. Nothing was connected; try again.',
  },
  failed: { tone: 'error', text: 'The Companion sign-in did not say who it was. Nothing was connected.' },
};

/**
 * "Companion account" in Account settings: connect a Companion (Portal) sign-in to this account, or
 * disconnect it.
 *
 * Connecting is how an owner who set up Memory with a password adds Portal sign-in. The address
 * they typed at setup does not count as proven, so the Portal sign-in no longer links to it by
 * address. Here the account is proven with the password (or a recent sign-in, for an account with
 * none of its own), and the Portal round trip that follows proves the identity.
 */
export function CompanionAccountGroup({
  authToken,
  asksCurrentPassword,
  signInAgain,
  companionAccount,
  onChanged,
}: {
  authToken: string | null;
  asksCurrentPassword: boolean;
  signInAgain: string;
  companionAccount: { email: string | null } | null;
  onChanged: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [returned, setReturned] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  // The callback returns here with `?companion=<outcome>`. Read it once, then drop it from the
  // address, so a reload does not say it again.
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('companion');

    if (outcome == null) {
      return;
    }

    setReturned(RETURN_MESSAGES[outcome] ?? RETURN_MESSAGES.failed);
    url.searchParams.delete('companion');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, []);

  const headers = {
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
  const body = JSON.stringify(asksCurrentPassword ? { currentPassword } : {});

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setReturned(null);

    try {
      const result = await fetchJson<{ redirect: string }>('/api/account/companion-link', {
        method: 'POST',
        headers,
        body,
      });

      if (!result?.redirect) {
        throw new Error('No sign-in to go to');
      }

      // The ordinary Portal sign-in, which comes back to this page.
      window.location.assign(result.redirect);
    } catch (err) {
      setError(messageFrom(err, 'Could not start connecting a Companion account.', signInAgain));
      setBusy(false);
    }
  };

  const disconnect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setReturned(null);

    try {
      await fetchJson('/api/account/companion-link', { method: 'DELETE', headers, body });
      setCurrentPassword('');
      setReturned({ tone: 'success', text: 'Companion account disconnected. Sign in with your password.' });
      onChanged();
    } catch (err) {
      setError(messageFrom(err, 'Could not disconnect the Companion account.', signInAgain));
    } finally {
      setBusy(false);
    }
  };

  const connected = companionAccount != null;
  // Disconnecting would leave an account with no password of its own no way in; the server refuses
  // it too.
  const canDisconnect = connected && asksCurrentPassword;

  return (
    <SettingsGroup
      title="Companion account"
      description={
        connected
          ? `Connected${companionAccount.email ? ` as ${companionAccount.email}` : ''}. You can sign in to Memory with it.`
          : 'Sign in to Memory with your Companion account as well as your password.'
      }
    >
      {connected && !canDisconnect ? (
        <SettingsRow
          label="Connected"
          hint="It's how you sign in to this account, so it can't be disconnected until you set a password above."
        />
      ) : (
        <SettingsForm onSubmit={connected ? disconnect : connect}>
          {asksCurrentPassword && (
            <SettingsRow label="Current password" htmlFor="companionCurrentPassword">
              <PasswordInput
                id="companionCurrentPassword"
                value={currentPassword}
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                  setError(null);
                }}
                autoComplete="current-password"
                required
              />
            </SettingsRow>
          )}
          <SettingsRow
            label={connected ? 'Disconnect' : 'Connect'}
            control={
              <Button type="submit" variant={connected ? 'outline' : 'default'} disabled={busy}>
                {busy ? 'Working…' : connected ? 'Disconnect Companion account' : 'Connect Companion account'}
              </Button>
            }
          />
        </SettingsForm>
      )}
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
      {returned ? <SettingsStatus tone={returned.tone}>{returned.text}</SettingsStatus> : null}
    </SettingsGroup>
  );
}
