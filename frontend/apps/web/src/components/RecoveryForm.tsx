import { useState, type FormEvent } from 'react';

import { fetchJson, isNativePlatform } from '@ci/common';
import { Button, Input, Label, PasswordInput } from '@ci/shadcn';

/** Recovery is unauthenticated and never sends a phone's stale API key. */
export async function recoverWithCode(email: string, code: string, newPassword: string): Promise<void> {
  const credentials = isNativePlatform() ? 'omit' : 'include';
  const csrf = await fetchJson<{ csrfToken: string }>('/api/authenticate/csrf', {
    credentials,
    skipApiKey: true,
    timeout: 15_000,
  });
  if (!csrf?.csrfToken) {
    throw new Error('Could not begin account recovery. Check your connection and try again.');
  }

  await fetchJson('/api/account-recovery', {
    method: 'POST',
    credentials,
    skipApiKey: true,
    timeout: 15_000,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
    body: JSON.stringify({ email, code, newPassword }),
  });
}

export function RecoveryForm() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('New passwords do not match.');

      return;
    }

    setBusy(true);
    try {
      await recoverWithCode(email, code, password);
      setCode('');
      setPassword('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Recovery failed. Check your email and unused recovery code.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mt-4 border-t border-border pt-4 text-sm">
      <summary className="min-h-11 cursor-pointer font-medium">Recover with a recovery code</summary>
      <p className="mb-4 text-muted-foreground">
        Use an unused code saved from Account settings. This resets your local Memory password and signs out
        your other sessions and signed-in apps. Companion account sign-in is managed separately.
      </p>
      {done ? (
        <p role="status">
          Password reset. Sign in again with your new password. That recovery code can no longer be used.
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="recovery-email">Account email</Label>
            <Input
              id="recovery-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="recovery-code">Recovery code</Label>
            <Input
              id="recovery-code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="recovery-password">New password</Label>
            <PasswordInput
              id="recovery-password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="recovery-confirm">Confirm new password</Label>
            <PasswordInput
              id="recovery-confirm"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="min-h-11 w-full">
            {busy ? 'Resetting…' : 'Reset password'}
          </Button>
        </form>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Without a saved code, use Companion sign-in or ask this Memory’s operator for account recovery. The
        app cannot recreate a lost code.
      </p>
    </details>
  );
}
