import { useEffect, useState, type FormEvent } from 'react';

import { fetchJson, FetchJsonError } from '@ci/common';
import { Button, Card, Dialog, Input, Label, PasswordInput } from '@ci/shadcn';
import { TriangleAlert } from '@ci/shadcn/icons';

import { useAuth, useCurrentUser } from '@/hooks';

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof FetchJsonError && error.status === 401 && error.message === 'REAUTH_REQUIRED') {
    // A Companion-signed-in account with no password of its own proves itself by a recent
    // sign-in instead; the window has passed.
    return 'Sign in again to make this change.';
  }

  return error instanceof FetchJsonError ? error.message : fallback;
}

/**
 * Account settings — currently just deletion, which exists because both stores
 * require it: an app offering in-app signup must offer in-app account deletion
 * (Apple Guideline 5.1.1(v), Google Play Data Deletion). Self-hosting is not an
 * exemption; the initiation path has to live in the app even though the data sits on
 * the user's own appliance.
 *
 * The copy below states 30 days because that is `accountDeletion.graceDays` on the
 * server, which stamps `purge_after` at request time. If that default changes, this
 * text has to change with it — it is a promise made to the person clicking the
 * button, and the store disclosures repeat it. See
 * `docs/architecture/account-deletion.md`.
 */
const PURGE_GRACE_DESCRIPTION = '30 days';
export function AccountSection() {
  const [{ authToken }, { logout }] = useAuth();
  const { user, refetch: refetchUser } = useCurrentUser();

  const [open, setOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email = user?.email ?? '';
  // Mirrors the server's comparison so the button is only live when the request would
  // actually be accepted — the user should never meet the 400.
  const matches = email.length > 0 && confirmEmail.trim().toLowerCase() === email.trim().toLowerCase();

  // OIDC-linked accounts (`ci.federated_identities`) were given a random 32-byte
  // password at signup that the user has never seen — asking for a "current
  // password" to change email/password would lock them out permanently, the same
  // reason account deletion above doesn't require one either.
  const [hasFederatedIdentity, setHasFederatedIdentity] = useState(false);
  // A federated account that has set a password of its own is asked for it like any other.
  const [hasOwnPassword, setHasOwnPassword] = useState(false);
  const asksCurrentPassword = !hasFederatedIdentity || hasOwnPassword;

  useEffect(() => {
    fetchJson<{ email: string; hasFederatedIdentity: boolean; hasOwnPassword: boolean }>('/api/account', {
      headers: { ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    })
      .then((result) => {
        setHasFederatedIdentity(result?.hasFederatedIdentity ?? false);
        setHasOwnPassword(result?.hasOwnPassword ?? false);
      })
      .catch(() => {});
  }, [authToken]);

  const [newEmail, setNewEmail] = useState('');
  const [emailCurrentPassword, setEmailCurrentPassword] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSavedNote, setEmailSavedNote] = useState<string | null>(null);

  const handleChangeEmail = async (e: FormEvent) => {
    e.preventDefault();
    setEmailSaving(true);
    setEmailError(null);
    setEmailSavedNote(null);

    try {
      await fetchJson('/api/account/email', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          newEmail: newEmail.trim(),
          ...(asksCurrentPassword ? { currentPassword: emailCurrentPassword } : {}),
        }),
      });

      setEmailSavedNote('Email updated.');
      setNewEmail('');
      setEmailCurrentPassword('');
      await refetchUser();
    } catch (err) {
      setEmailError(messageFrom(err, 'Could not update email.'));
    } finally {
      setEmailSaving(false);
    }
  };

  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordCurrentPassword, setPasswordCurrentPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSavedNote, setPasswordSavedNote] = useState<string | null>(null);

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmNewPassword) {
      setPasswordError('New passwords do not match.');

      return;
    }

    setPasswordSaving(true);
    setPasswordError(null);
    setPasswordSavedNote(null);

    try {
      await fetchJson('/api/account/password', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          newPassword,
          ...(asksCurrentPassword ? { currentPassword: passwordCurrentPassword } : {}),
        }),
      });

      setPasswordSavedNote('Password updated. Other signed-in devices have been signed out.');
      setNewPassword('');
      setConfirmNewPassword('');
      setPasswordCurrentPassword('');
      setHasOwnPassword(true);
    } catch (err) {
      setPasswordError(messageFrom(err, 'Could not update password.'));
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleDelete = async () => {
    setLoading(true);
    setError(null);

    try {
      await fetchJson('/api/account', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          // Native holds no JWT — it authenticates with a durable API key, which
          // fetchJson attaches as `x-api-key` on its own. Sending `Bearer null` here
          // would break the very client this feature exists for.
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ confirmEmail: confirmEmail.trim() }),
      });

      // The account stops authenticating immediately, so there is nothing left to
      // stay signed in to: drop the local credential and return to a logged-out app.
      await logout();
    } catch {
      setError('Could not delete the account. Please try again.');
      setLoading(false);
    }
  };

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Account</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {email ? <>Signed in as {email}.</> : 'Manage your account.'}
        </p>
      </div>

      <Card className="py-0">
        <Card.Content>
          <form className="space-y-4" onSubmit={handleChangeEmail}>
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Change email</h3>
              <p className="text-sm text-muted-foreground">You'll use this address to sign in.</p>
            </div>

            {asksCurrentPassword && (
              <div className="grid gap-2">
                <Label htmlFor="emailCurrentPassword">Current password</Label>
                <PasswordInput
                  id="emailCurrentPassword"
                  autoComplete="current-password"
                  value={emailCurrentPassword}
                  onChange={(e) => setEmailCurrentPassword(e.target.value)}
                  disabled={emailSaving}
                  required
                />
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="newEmail">New email</Label>
              <Input
                id="newEmail"
                type="email"
                autoComplete="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                disabled={emailSaving}
                required
              />
            </div>

            {emailError && <p className="text-sm text-destructive">{emailError}</p>}
            {emailSavedNote && <p className="text-sm text-muted-foreground">{emailSavedNote}</p>}

            <Button type="submit" size="sm" disabled={emailSaving || newEmail.trim().length === 0}>
              {emailSaving ? 'Saving…' : 'Update email'}
            </Button>
          </form>
        </Card.Content>
      </Card>

      <Card className="py-0">
        <Card.Content>
          <form className="space-y-4" onSubmit={handleChangePassword}>
            <div className="space-y-1">
              <h3 className="text-sm font-medium">
                {asksCurrentPassword ? 'Change password' : 'Set a password'}
              </h3>
              <p className="text-sm text-muted-foreground">
                {asksCurrentPassword
                  ? 'Changing your password signs out every other device.'
                  : 'You signed in with a Companion account and have no password yet — set one to also sign in with email.'}
              </p>
            </div>

            {asksCurrentPassword && (
              <div className="grid gap-2">
                <Label htmlFor="passwordCurrentPassword">Current password</Label>
                <PasswordInput
                  id="passwordCurrentPassword"
                  autoComplete="current-password"
                  value={passwordCurrentPassword}
                  onChange={(e) => setPasswordCurrentPassword(e.target.value)}
                  disabled={passwordSaving}
                  required
                />
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="newPassword">New password</Label>
              <PasswordInput
                id="newPassword"
                autoComplete="new-password"
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={passwordSaving}
                required
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="confirmNewPassword">Confirm new password</Label>
              <PasswordInput
                id="confirmNewPassword"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                disabled={passwordSaving}
                required
              />
            </div>

            {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
            {passwordSavedNote && <p className="text-sm text-muted-foreground">{passwordSavedNote}</p>}

            <Button
              type="submit"
              size="sm"
              disabled={passwordSaving || newPassword.length === 0 || confirmNewPassword.length === 0}
            >
              {passwordSaving ? 'Saving…' : hasFederatedIdentity ? 'Set password' : 'Update password'}
            </Button>
          </form>
        </Card.Content>
      </Card>

      <Card className="border-destructive/40 mb-[max(1rem,var(--safe-area-bottom))]">
        <Card.Header>
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" strokeWidth={1.5} />
            <div className="space-y-1">
              <Card.Title>Delete account</Card.Title>
              <Card.Description>
                Signs you out everywhere immediately. This account, its memories and any files you uploaded
                are then permanently deleted from this server after {PURGE_GRACE_DESCRIPTION}. This cannot be
                undone.
              </Card.Description>
            </div>
          </div>
        </Card.Header>
        <Card.Content>
          <Button variant="destructive" disabled={!email} onClick={() => setOpen(true)}>
            Delete account
          </Button>
        </Card.Content>
      </Card>

      <Dialog
        open={open}
        onOpenChange={(next: boolean) => {
          setOpen(next);

          if (!next) {
            setConfirmEmail('');
            setError(null);
          }
        }}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Delete your account?</Dialog.Title>
            <Dialog.Description>
              Your access is revoked right away. After {PURGE_GRACE_DESCRIPTION} this account, its memories
              and any files you uploaded are permanently deleted from this server. This cannot be undone.
            </Dialog.Description>
          </Dialog.Header>

          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="confirmEmail">
                Type <span className="font-medium text-foreground">{email}</span> to confirm
              </Label>
              <Input
                id="confirmEmail"
                autoComplete="off"
                placeholder={email}
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && matches && !loading && handleDelete()}
              />
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={!matches || loading}>
              {loading ? 'Deleting…' : 'Delete account'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
