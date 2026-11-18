import { useEffect, useState } from 'react';

import { getDesktopRecommendedModel, type DesktopRecommendedModel } from '@ci/common';
import { Link } from 'react-router-dom';

import { useLlmEndpoint } from '@/hooks/useLlmEndpoint';
import {
  listOf,
  recommendedModelOffer,
  usesDesktopOllama,
  type RecommendedModelOffer,
} from '@/pages/SettingsPage/sections/RecommendedModelCard';

/**
 * How often a line on screen asks Memory Desktop again. A download started in Settings ends the offer, but this page
 * hears nothing of it: Settings opens over the page without leaving it. A download that ends while Memory is stopped
 * never reloads the model list either.
 */
const RECHECK_MS = 15_000;

interface ModelSettingsTarget {
  to: string;
  state?: unknown;
}

/**
 * A line under the getting-started "Chat model ready" step, inside Memory Desktop only: Settings > Model has a
 * Recommended model card for this person. Any model that answers ticks the step, a 122B one far too slow for
 * background work included. Nothing else on the way in points at the card.
 *
 * Shown under the same conditions as the card's offer. Settings points Memory at the person's own Ollama. That Ollama
 * lacks a recommended model or Memory runs on another chat model. Nothing in a browser, on a phone or with Memory
 * Desktop's own Ollama.
 */
export function RecommendedModelHint({
  target,
  recheck,
}: {
  target: ModelSettingsTarget;
  /** Asks Memory Desktop again when this changes: the model list reloads after a download or a switch. */
  recheck: unknown;
}) {
  const [status, setStatus] = useState<DesktopRecommendedModel | null>(null);

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
  }, [recheck]);

  const offer = recommendedModelOffer(status);

  // The endpoint is asked for only once there is an offer, so a browser or a phone never fetches it for this line.
  return offer ? <OfferLine offer={offer} target={target} onAnswer={setStatus} /> : null;
}

function OfferLine({
  offer,
  target,
  onAnswer,
}: {
  offer: RecommendedModelOffer;
  target: ModelSettingsTarget;
  onAnswer: (status: DesktopRecommendedModel) => void;
}) {
  const { config } = useLlmEndpoint();
  const shown = usesDesktopOllama(config);

  // Asks again only while the line is on screen. With Memory pointed at another inference server it never is. Each ask
  // would then list the person's Ollama for nothing.
  useEffect(() => {
    if (!shown) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }

      void getDesktopRecommendedModel().then((next) => {
        // A failed ask says nothing new about the offer, so the line stays until Memory Desktop answers again.
        if (!cancelled && next) {
          onAnswer(next);
        }
      });
    }, RECHECK_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [shown, onAnswer]);

  if (!shown) {
    return null;
  }

  return (
    <p className="text-xs text-muted-foreground" data-testid="recommended-model-hint">
      {offer.chatModel
        ? `Memory Desktop recommends ${offer.chatModel}, a small model that keeps chat and summaries quick.`
        : `Search needs ${listOf(offer.others)}, which your Ollama doesn’t have.`}{' '}
      <Link
        to={target.to}
        state={target.state}
        className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
      >
        Open model settings
      </Link>
    </p>
  );
}
