import { AlertDialog } from '@ci/shadcn';

import { useAuth } from '@/hooks';

/**
 * The question a phone sign-out asks when captures it could not upload are still queued:
 * signing out deletes them. Nothing is signed out or deleted until "Sign out"; "Cancel"
 * keeps the session and the queue as they are. The copy promises only that: a capture
 * waiting for the connection uploads once it is back, but one the Memory refused stays in
 * "needs attention" until someone retries it.
 *
 * Mounted once, inside `AuthProvider`, because `useAuth`'s logout raises the question for
 * every way out (Log out in the Self menu, Log out on the phone's Settings page), and the
 * button that started it may be gone by the time the last upload try ends.
 */
export function UnsentCapturesSignOutDialog() {
  const [{ signOutPrompt }, { confirmSignOut, cancelSignOut }] = useAuth();
  const { open, unsentCaptures } = signOutPrompt;
  const one = unsentCaptures === 1;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          cancelSignOut();
        }
      }}
    >
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>
            {one ? "1 capture hasn't uploaded yet" : `${unsentCaptures} captures haven't uploaded yet`}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {one
              ? 'Sign out and delete it? To keep it, cancel and stay signed in.'
              : 'Sign out and delete them? To keep them, cancel and stay signed in.'}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
          <AlertDialog.Action
            // AlertDialog.Action renders the default button variant, so the destructive
            // styling has to come from here (as on the account menu's "Log out?").
            className="bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60"
            onClick={() => void confirmSignOut()}
          >
            Sign out
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog>
  );
}
