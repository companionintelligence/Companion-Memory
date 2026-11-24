import { useState, type FormEvent } from 'react';

import { fetchJson } from '@ci/common';
import { Button, PasswordInput } from '@ci/shadcn';

import { useAuth } from '@/hooks';

import { SettingsFooter, SettingsForm, SettingsGroup, SettingsRow, SettingsStatus } from '../kit';

const DEFAULT_SIGN_IN_AGAIN = 'Sign in again in this browser to generate recovery codes.';

export function RecoveryCodesSection({
  requiresPassword,
  signInAgain = DEFAULT_SIGN_IN_AGAIN,
}: {
  requiresPassword: boolean;
  /** What to say when the server asks for a fresh sign-in first (401 `REAUTH_REQUIRED`). */
  signInAgain?: string;
}) {
  const [{ authToken }] = useAuth();
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const generate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const result = await fetchJson<{ codes: string[] }>('/api/account/recovery-codes', {
        timeout: 15_000,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ ...(requiresPassword ? { currentPassword: password } : {}) }),
      });
      if (!result?.codes.length) {
        throw new Error('No recovery codes returned.');
      }

      setCodes(result.codes);
      setPassword('');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message === 'REAUTH_REQUIRED'
            ? signInAgain
            : err.message
          : 'Could not generate recovery codes. Sign in again and retry.',
      );
    } finally {
      setBusy(false);
    }
  };

  const status = error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null;

  return (
    <SettingsGroup
      title="Recovery codes"
      description="Save these before you need them. Each code can reset your local Memory password once. Generating a new set invalidates every previous code."
    >
      {codes.length > 0 ? (
        <>
          <SettingsRow hint="These codes are shown once. Store them somewhere private outside this Memory. Anyone holding one can reset your local password.">
            <ul className="space-y-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
              {codes.map((code) => (
                <li key={code}>
                  <code className="select-all whitespace-nowrap">{code}</code>
                </li>
              ))}
            </ul>
          </SettingsRow>
          <SettingsFooter status={status}>
            <Button
              variant="outline"
              onClick={() => {
                if (!navigator.clipboard?.writeText) {
                  setError('Clipboard unavailable. Select and copy the codes manually.');

                  return;
                }

                void navigator.clipboard
                  .writeText(codes.join('\n'))
                  .then(() => setCopied(true))
                  .catch(() => setError('Clipboard unavailable. Select and copy the codes manually.'));
              }}
            >
              {copied ? 'Copied' : 'Copy codes'}
            </Button>
            <Button onClick={() => setCodes([])}>I saved these codes</Button>
          </SettingsFooter>
        </>
      ) : (
        <SettingsForm onSubmit={(event) => void generate(event)}>
          {requiresPassword ? (
            <SettingsRow label="Current password" htmlFor="recovery-current-password">
              <PasswordInput
                id="recovery-current-password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                required
              />
            </SettingsRow>
          ) : (
            <SettingsRow hint="A recent web sign-in is required. If asked, sign out and sign back in before generating codes." />
          )}
          <SettingsFooter status={status}>
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? 'Generating…' : 'Generate new recovery codes'}
            </Button>
          </SettingsFooter>
        </SettingsForm>
      )}
    </SettingsGroup>
  );
}
