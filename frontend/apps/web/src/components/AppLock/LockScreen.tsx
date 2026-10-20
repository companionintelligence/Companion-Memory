import { Button } from '@ci/shadcn';
import { LockKeyhole } from '@ci/shadcn/icons';

interface Props {
  /** The queue line, e.g. "3 captures waiting to sync"; empty hides it. */
  note?: string;
  busy?: boolean;
  onUnlock: () => void;
}

/**
 * What the web app shows while the native lock is engaged. The native overlay above the
 * WebView is the control that actually hides the page (v2); this screen is what the page
 * itself renders underneath it (v1), so that nothing sensitive is mounted while locked and
 * so that a WebView-only path (debug tooling, a future platform without the overlay) still
 * shows a lock and not the memory.
 */
export function LockScreen({ note, busy = false, onUnlock }: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Companion Memory is locked"
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-8 text-center"
    >
      <LockKeyhole className="h-10 w-10 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <h1 className="text-xl font-semibold">Companion Memory</h1>
      <p className="text-sm text-muted-foreground">Locked</p>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      <Button className="mt-4" onClick={onUnlock} disabled={busy}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
    </div>
  );
}
