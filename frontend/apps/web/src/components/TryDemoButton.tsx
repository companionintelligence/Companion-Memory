import { useState } from 'react';

import { LoadingButton } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { connectToDemoServer, getDemoServerOrigin } from '@/lib/demoServer';

type Props = {
  /** Disable while the host screen is busy with its own request. */
  disabled?: boolean;
  className?: string;
};

/**
 * One-tap "point this app at the hosted demo Memory Server".
 *
 * Companion Memory is self-hosted, so first launch asks for a server the app has no
 * way to guess. An App Store / Play reviewer has neither an appliance nor a hostname,
 * and typing one wrong is indistinguishable from the product being broken — so the
 * reviewer path is a single button, not a text field.
 *
 * Renders nothing when the build has no demo origin (see `lib/demoServer`), which is
 * the normal case for a self-hoster's own build. The demo instance is operated by
 * Lifescope, so the hint copy says so out loud: anything typed into it is visible to
 * us, which is exactly what the store privacy declarations have to state.
 */
export function TryDemoButton({ disabled, className }: Props) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const origin = getDemoServerOrigin();

  if (!origin) {
    return null;
  }

  const handleClick = async () => {
    setBusy(true);
    setError(null);

    try {
      await connectToDemoServer(origin);

      // Same hand-off as a manually entered origin: the splash route decides
      // login-vs-feed from here.
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err instanceof Error && err.name === 'AbortError'
          ? 'The demo Memory Server did not respond in time. Please try again.'
          : `Could not reach the demo Memory Server. ${err instanceof Error ? err.message : ''}`.trim(),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      <LoadingButton
        type="button"
        variant="outline"
        className="min-h-[44px] w-full"
        loading={busy}
        disabled={busy || disabled}
        onClick={() => void handleClick()}
      >
        Try the demo
      </LoadingButton>
      <p className="text-muted-foreground text-xs">
        Connects to {origin} — a sample Companion Memory hosted by Lifescope, with example data. It is
        shared and not private: don&apos;t put anything real in it.
      </p>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </div>
  );
}
