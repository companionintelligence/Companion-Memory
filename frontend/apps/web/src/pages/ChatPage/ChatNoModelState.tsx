import { FetchJsonError, useDeviceLayout } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Cpu, MonitorOff, RefreshCw } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { useDesktopApp } from '@/hooks';
import { settingsSectionTarget } from '@/layouts/Main/SecondaryNavigation/selfSections';

interface ChatNoModelStateProps {
  /** The model list could not be fetched, as opposed to coming back empty. */
  unreachable: boolean;
  /** The server's own account of what failed, from {@link modelServerFailureDetail}. */
  detail?: string;
  onRetry?: () => void;
}

/**
 * What the server said about a model list it could not fetch, when it said something.
 *
 * The models route answers a model server that gave no HTTP answer with a 503 naming the address it
 * tried and the likely cause (refused, timed out, not found). Anything else, including a proxy's 503
 * with no message of its own, gives nothing and the generic advice stays.
 */
export function modelServerFailureDetail(error: Error | null | undefined): string | undefined {
  if (!(error instanceof FetchJsonError) || error.status !== 503) {
    return undefined;
  }

  // fetchJson's own wording for an error body it could not read.
  return error.message.startsWith('Fetch failed:') ? undefined : error.message;
}

/**
 * What Chat shows in place of the starter asks when there is no model to answer
 * them.
 *
 * Until this existed the composer and every starter were simply disabled, with
 * nothing on the page saying why — the one thing a first-run user needs to do
 * (point the appliance at a model server) was two screens away in Settings, and
 * the only hint was a greyed-out select reading "No model set up".
 *
 * The two causes get different words because they have different fixes: an
 * empty list means nothing is set up (or the server has no model pulled), an
 * unreachable one means what IS set up is not answering.
 */
export function ChatNoModelState({ unreachable, detail, onRetry }: ChatNoModelStateProps) {
  const { isMobile } = useDeviceLayout();
  const location = useLocation();
  const desktopApp = useDesktopApp();

  // `null` only while the layout is unknown; the desktop overlay path is a fine
  // answer for that one render.
  const target = settingsSectionTarget('model', isMobile, location) ?? { to: '/settings/model' };

  // A third cause with its own fix: Memory Desktop was closed and took the model
  // it ran with it. Settings would only send the person looking for a server to
  // fix; opening the app is the whole answer.
  if (unreachable && desktopApp.closed) {
    return (
      <div
        role="status"
        data-testid="chat-no-model"
        className="flex w-full max-w-md flex-col items-center px-2 text-center"
      >
        <div className="mb-4 flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted">
          <MonitorOff className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
        </div>
        <h2 className="mb-1 text-base font-semibold text-foreground">Memory Desktop is closed</h2>
        <p className="mb-5 text-sm text-muted-foreground">
          Chat runs on the model that Memory Desktop starts, and it stopped when the app was closed. Open
          Memory Desktop to bring chat back.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            desktopApp.refetch();
            onRetry?.();
          }}
        >
          <RefreshCw className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
          Check again
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-testid="chat-no-model"
      className="flex w-full max-w-md flex-col items-center px-2 text-center"
    >
      <div className="mb-4 flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted">
        <Cpu className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <h2 className="mb-1 text-base font-semibold text-foreground">
        {unreachable ? 'Chat can’t reach a model' : 'Chat needs a model'}
      </h2>
      <p className="mb-5 text-sm text-muted-foreground">
        {unreachable && detail
          ? `Companion answers with a language model running on your own hardware, and the model server isn’t responding. ${detail}`
          : unreachable
            ? 'Companion answers with a language model running on your own hardware, and the model server isn’t responding. Check that Ollama (or your OpenAI-compatible server) is running, or point Companion at a different one in Settings.'
            : 'Companion answers with a language model running on your own hardware, and none is set up yet. Point it at your Ollama or OpenAI-compatible server in Settings, and pick a model.'}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button asChild>
          <Link to={target.to} state={target.state}>
            Open Settings → Model
          </Link>
        </Button>
        {onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
            Check again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
