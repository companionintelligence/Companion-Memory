// What Settings > Model's Recommended model card offers, shared with the home screen's getting-started line that
// points at it. Kept out of the card so the line, which every page loads, does not pull in the lazily loaded Settings
// section.

import type { DesktopRecommendedModel } from '@ci/common';

import type { LlmEndpointConfig } from '@/hooks/useLlmEndpoint';

/** Where Ollama listens unless told otherwise, and where Memory Desktop looks for a person's own Ollama. */
const OLLAMA_PORT = 11434;

/** `a`, `a and b`, `a, b and c`. */
export function listOf(models: string[]): string {
  return models.length > 1 ? `${models.slice(0, -1).join(', ')} and ${models[models.length - 1]}` : models[0];
}

/** What the card offers to download or switch to while no download is running. */
export interface RecommendedModelOffer {
  /** The recommended chat model, offered when the person's Ollama lacks it or Memory runs on another. */
  chatModel: string | null;
  /** The other recommended models the person's Ollama lacks: the embedding model search needs. */
  others: string[];
}

/**
 * What the card offers, or null when it offers nothing: not the person's own Ollama, an Ollama that did not answer,
 * a download running, or nothing missing with Memory on the recommended model. The home screen's chat model step
 * points at the card with it.
 */
export function recommendedModelOffer(status: DesktopRecommendedModel | null): RecommendedModelOffer | null {
  if (!status?.ownOllama || status.missing == null) {
    return null;
  }

  const runsOnOther = status.chatModel != null && status.chatModel !== status.recommended;
  const chatModel = status.missing.includes(status.recommended) || runsOnOther ? status.recommended : null;
  const others = status.missing.filter((model) => model !== status.recommended);

  return chatModel != null || others.length > 0 ? { chatModel, others } : null;
}

/**
 * Settings points Memory at the Ollama Memory Desktop downloads into. With Memory pointed anywhere else that Ollama
 * serves nothing. The restart would also name a model the other server may not have.
 */
export function usesDesktopOllama(endpoint: Pick<LlmEndpointConfig, 'backend' | 'port'> | null): boolean {
  return endpoint?.backend === 'ollama' && endpoint.port === OLLAMA_PORT;
}
