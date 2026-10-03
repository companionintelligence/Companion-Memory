import { useDeviceLayout } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Cpu, RefreshCw } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { settingsSectionTarget } from '@/layouts/Main/SecondaryNavigation/selfSections';

interface ChatNoModelStateProps {
  /** The model list could not be fetched, as opposed to coming back empty. */
  unreachable: boolean;
  onRetry?: () => void;
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
export function ChatNoModelState({ unreachable, onRetry }: ChatNoModelStateProps) {
  const { isMobile } = useDeviceLayout();
  const location = useLocation();

  // `null` only while the layout is unknown; the desktop overlay path is a fine
  // answer for that one render.
  const target = settingsSectionTarget('model', isMobile, location) ?? { to: '/settings/model' };

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
        {unreachable
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
