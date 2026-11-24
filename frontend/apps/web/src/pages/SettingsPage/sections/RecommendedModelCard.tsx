import { useCallback, useEffect, useState } from 'react';

import {
  downloadDesktopRecommendedModel,
  formatModelBytes,
  getDesktopRecommendedModel,
  type DesktopRecommendedModel,
} from '@ci/common';
import { Button, Progress } from '@ci/shadcn';
import { Download } from '@ci/shadcn/icons';

import type { LlmEndpointConfig } from '@/hooks/useLlmEndpoint';
import { listOf, recommendedModelOffer, usesDesktopOllama } from '@/lib/recommendedModel';

import { SettingsGroup, SettingsRow, SettingsStatus } from '../kit';

/** How often a running download is asked how far it has got. */
const POLL_MS = 1000;

/** How often a download that ended while Memory was stopped is asked whether Memory has started since. */
const START_POLL_MS = 3000;

/**
 * Whether the model list has been reloaded for the download that ended last. Settings > Model mounts the card afresh
 * each time it opens and Memory Desktop reports that download as done until it quits, so without this every later
 * open would empty and reload the list again. Kept for as long as the page is loaded.
 */
let reloadedForLastDone = false;

function percent(completed: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
}

/** Whether there is anything to say: a model to download, a switch to make, or a download to report on. */
function hasSomethingToSay(status: DesktopRecommendedModel): boolean {
  if (!status.ownOllama) {
    return false;
  }

  if (status.download.state !== 'idle') {
    return true;
  }

  return recommendedModelOffer(status) != null;
}

/**
 * Settings > Model, inside Memory Desktop only: "Download recommended model" for a person whose own Ollama lacks the
 * model Memory Desktop would have downloaded for itself. Without it Memory runs on the first chat model that Ollama
 * lists, which can be one far too large for background work. Memory Desktop does the download and then restarts
 * Memory on the recommended model; this page starts it and shows how it is going.
 *
 * Renders nothing in a browser, on a phone, with Memory Desktop's own Ollama, when the person's Ollama already has
 * everything, or when Settings points Memory at another inference server.
 */
export function RecommendedModelCard({
  endpoint,
  canDownload,
  onSwitched,
}: {
  /**
   * The inference server Memory uses (Settings > Model > Inference server). Memory Desktop pulls into the Ollama on
   * port 11434 and restarts Memory on the recommended model. With Memory pointed anywhere else that Ollama serves
   * nothing, and the restart would name a model the other server may not have.
   */
  endpoint: Pick<LlmEndpointConfig, 'backend' | 'port'> | null;
  /** An administrator: the download changes the model Memory runs on for everyone. */
  canDownload: boolean;
  /** Called once a download this page watched has finished, so the model list can be loaded again. */
  onSwitched: () => void;
}) {
  const [status, setStatus] = useState<DesktopRecommendedModel | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void getDesktopRecommendedModel().then((next) => {
      if (!cancelled) {
        setStatus(next);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const state = status?.download.state;
  const running = state === 'downloading' || state === 'switching';
  // Memory was stopped from the tray when the download ended: it runs on the new model once it is started again.
  const waitsForStart = status?.download.state === 'done' && status.download.waitsForStart;
  const phase = waitsForStart ? 'waiting' : (state ?? null);

  useEffect(() => {
    if (!running && !waitsForStart) {
      return;
    }

    const timer = window.setInterval(
      () => {
        void getDesktopRecommendedModel().then((next) => {
          if (next) {
            setStatus(next);
          }
        });
      },
      running ? POLL_MS : START_POLL_MS,
    );

    return () => window.clearInterval(timer);
  }, [running, waitsForStart]);

  // The model list is reloaded once per download, when Memory runs on the new model. That is when a download this card
  // followed ends or when Memory answers again after one that ended while it was stopped. It is also when the card
  // opens on one that ended while Settings was closed, which left the list on the old model. After a page reload that
  // one reload is redundant but harmless.
  useEffect(() => {
    if (phase === 'done') {
      if (!reloadedForLastDone) {
        reloadedForLastDone = true;
        onSwitched();
      }
    } else if (phase != null && phase !== 'idle') {
      // Running, waiting for Memory to start or failed: the done that follows belongs to a new download.
      reloadedForLastDone = false;
    }
  }, [phase, onSwitched]);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);

    try {
      setStatus(await downloadDesktopRecommendedModel());
    } catch (error) {
      setStartError(
        typeof error === 'string' ? error : error instanceof Error ? error.message : String(error),
      );
    } finally {
      setStarting(false);
    }
  }, []);

  if (!status || !hasSomethingToSay(status) || !usesDesktopOllama(endpoint)) {
    return null;
  }

  const { recommended, chatModel, missing, download } = status;
  // Unknown while the person's Ollama is not answering: then nothing is said about what it has.
  const chatMissing = missing?.includes(recommended) ?? false;
  const othersMissing = missing?.filter((model) => model !== recommended) ?? [];
  // Memory asks for a model other than the recommended one. `.env` names the recommended one even when it is not on
  // disk if the person's Ollama had no chat model at launch (or did not answer then).
  const runsOnOther = chatModel != null && chatModel !== recommended;

  let body: React.ReactNode;

  if (download.state === 'downloading') {
    body = (
      <div className="space-y-2">
        <p className="text-sm" role="status">
          Downloading {download.model} into your Ollama…
        </p>
        <Progress
          value={percent(download.completedBytes, download.totalBytes)}
          aria-label={`Downloading ${download.model}`}
        />
        <p className="text-xs text-muted-foreground">
          {download.totalBytes > 0
            ? `${formatModelBytes(download.completedBytes)} of ${formatModelBytes(download.totalBytes)}`
            : 'Starting…'}
        </p>
      </div>
    );
  } else if (download.state === 'switching') {
    body = (
      <p className="text-sm" role="status">
        Restarting Memory on {download.model}. This takes a minute or two. Memory may not answer until it is
        done.
      </p>
    );
  } else if (download.state === 'done') {
    body = (
      <SettingsStatus tone="success">
        {download.downloaded.length > 0 ? `Downloaded ${listOf(download.downloaded)}. ` : ''}
        {download.waitsForStart
          ? `Memory will use ${download.chatModel} the next time it starts.`
          : `Memory now runs on ${download.chatModel}.`}
      </SettingsStatus>
    );
  } else {
    const nothingMissing = missing?.length === 0;

    body = (
      <div className="space-y-3">
        {chatMissing ? (
          <p className="text-sm text-muted-foreground leading-relaxed">
            Memory Desktop recommends {recommended}, a small model that keeps chat and background work quick.{' '}
            {runsOnOther
              ? `Your Ollama doesn't have it, so Memory runs on ${chatModel} for now.`
              : chatModel === recommended
                ? "Memory asks for it, but your Ollama doesn't have it yet. Background work fails until it does."
                : // `.env` could not be read: which model Memory asks for is unknown.
                  "Your Ollama doesn't have it."}
          </p>
        ) : nothingMissing && runsOnOther ? (
          <p className="text-sm text-muted-foreground leading-relaxed">
            Your Ollama has {recommended} now, but Memory still runs on {chatModel}.
          </p>
        ) : null}
        {othersMissing.length > 0 ? (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {chatMissing ? 'Search also needs' : 'Search needs'} {listOf(othersMissing)}, which your Ollama
            doesn&apos;t have{chatMissing ? ' either' : ''}.
          </p>
        ) : null}

        {download.state === 'failed' ? (
          <SettingsStatus tone="error">{download.message}</SettingsStatus>
        ) : null}
        {startError ? <SettingsStatus tone="error">{startError}</SettingsStatus> : null}

        {canDownload ? (
          <div className="space-y-2">
            <Button type="button" onClick={() => void start()} disabled={starting}>
              <Download className="h-4 w-4" />
              {download.state === 'failed'
                ? 'Try again'
                : nothingMissing
                  ? 'Use recommended model'
                  : 'Download recommended model'}
            </Button>
            {nothingMissing ? null : (
              <p className="text-xs text-muted-foreground">
                It goes into your own Ollama and can take a while.
                {runsOnOther ? ` Memory restarts on ${recommended} when it is done.` : ''}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            An administrator of this Companion can {nothingMissing ? 'switch to it' : 'download it'} here.
          </p>
        )}
      </div>
    );
  }

  return (
    <SettingsGroup
      title="Recommended model"
      help="Memory Desktop downloads it into the Ollama on port 11434 and restarts Memory on it."
      testId="recommended-model"
    >
      <SettingsRow>{body}</SettingsRow>
    </SettingsGroup>
  );
}
