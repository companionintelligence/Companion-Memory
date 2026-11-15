import { Button } from '@ci/shadcn';
import { MonitorOff, RefreshCw } from '@ci/shadcn/icons';

import { useDesktopApp } from '@/hooks/useDesktopApp';

export const DESKTOP_APP_CLOSED_NOTICE =
  'Memory Desktop is closed, so chat, search and summaries are off. Open Memory Desktop to bring them back.';

/**
 * One row above every page while Memory Desktop is closed and the model it served is gone (see
 * `useDesktopApp`).
 *
 * Every page, because the model features fail together: chat, search, summaries and suggestions all
 * stop at once, and each used to fail on its own terms (a toast, an empty result, nothing at all) without
 * saying why. In the layout flow like `UnsyncedImportsBanner`, so it never covers the page or a dialog.
 * No dismiss: it says how things are, and it goes away by itself once the app is open again.
 */
export function DesktopAppClosedBanner() {
  const { closed, refetch } = useDesktopApp();

  if (!closed) {
    return null;
  }

  return (
    <div
      data-testid="desktop-app-closed-notice"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-sm text-foreground"
    >
      <MonitorOff className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p role="status" className="min-w-0 flex-1">
        {DESKTOP_APP_CLOSED_NOTICE}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={refetch}>
        <RefreshCw className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
        Check again
      </Button>
    </div>
  );
}
