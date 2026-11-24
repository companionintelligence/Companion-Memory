import { useCallback, useEffect, useState } from 'react';

import { createHookContext, fetchJson, isNativePlatform } from '@ci/common';

import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useSessionAuth } from './useSessionAuth';

/**
 * How often an open page asks again. The banner should appear within a few seconds of Quit and go away
 * as soon after the app is opened again; the server reuses its answer for 5s and reading it costs a file
 * read, so this is cheap.
 */
const POLL_INTERVAL_MS = 15_000;

interface DesktopAppAnswer {
  /** Memory runs under Memory Desktop. False everywhere else, and then nothing needs asking again. */
  desktop?: boolean;
  /** Memory Desktop is closed and the model it served is not answering. */
  closed?: boolean;
}

export interface DesktopAppStatus {
  /** Memory Desktop is closed, and with it the model chat, search and summaries run on. */
  closed: boolean;
  refetch: () => void;
}

/**
 * Whether Memory Desktop is closed (`GET /api/llm/desktop-app`).
 *
 * Its containers keep running after Quit, so a browser tab (this one included, on any computer that can
 * reach it) still opens Memory. When the app was what served the model, every model feature then fails
 * at once, and until this the page could only say that the model was unreachable. The answer is shared
 * by the banner on every page and by Chat, which words its own empty state from it.
 *
 * Off Memory Desktop the first answer says so and the polling stops. A phone never talks to a desktop
 * install (its gateway answers on the computer it runs on only), so it never asks.
 */
function useDesktopAppStatus(): DesktopAppStatus {
  const { ready, headers } = useSessionAuth();
  const [closed, setClosed] = useState(false);
  const [desktop, setDesktop] = useState(!isNativePlatform());

  const refetch = useCallback(() => {
    if (!ready || !desktop) {
      return;
    }

    void fetchJson<DesktopAppAnswer>('/api/llm/desktop-app', { method: 'GET', headers })
      .then((answer) => {
        setDesktop(answer?.desktop !== false);
        setClosed(answer?.closed === true);
      })
      // A server from before this route answers 404 and one that is down is shown as down elsewhere;
      // neither is a reason to say the app is closed.
      .catch(() => undefined);
  }, [ready, desktop, headers]);

  useEffect(() => {
    if (!ready || !desktop) {
      setClosed(false);

      return;
    }

    refetch();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        refetch();
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [ready, desktop, refetch]);

  useRefetchOnReturn(refetch);

  return { closed, refetch };
}

const { Provider, useOptionalHookContext } = createHookContext(useDesktopAppStatus, 'useDesktopApp');

const NOTHING_TO_SAY: DesktopAppStatus = { closed: false, refetch: () => undefined };

/** Outside the provider (a page rendered on its own in a test, say) there is nothing to say. */
function useDesktopApp(): DesktopAppStatus {
  return useOptionalHookContext() ?? NOTHING_TO_SAY;
}

export { Provider as DesktopAppProvider, useDesktopApp };
