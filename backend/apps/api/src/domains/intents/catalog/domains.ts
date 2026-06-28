/**
 * CI Schema Domains — the standardized capability vocabulary.
 *
 * A small, curated set of domains that intents are grouped under, so an assistant
 * reliably maps natural language to an action and CI-Hermes, CI-OpenClaw, and any
 * MCP client use the same verbs instead of inventing their own per-harness tool
 * names.
 */

import type { IntentDomain, IntentDomainKey } from '../types';

export const INTENT_DOMAINS: readonly IntentDomain[] = [
  {
    key: 'memory',
    title: 'Memory',
    description: 'Recall, remember, and forget facts in the personal knowledge graph.',
  },
  {
    key: 'knowledge',
    title: 'Knowledge',
    description: 'Search across the whole personal corpus and read stored preferences.',
  },
  {
    key: 'people',
    title: 'People',
    description: 'Find people and their relationships in the social graph.',
  },
  {
    key: 'places',
    title: 'Places',
    description: 'Find locations and places the user has visited or saved.',
  },
  {
    key: 'calendar',
    title: 'Calendar',
    description: 'Find and reason over events on the personal timeline.',
  },
  {
    key: 'media',
    title: 'Media',
    description: 'Find photos and videos, and resolve entertainment availability.',
  },
] as const;

const DOMAIN_KEYS = new Set<string>(INTENT_DOMAINS.map((d) => d.key));

/** True if `key` is a registered CI schema domain. */
export function isIntentDomain(key: string): key is IntentDomainKey {
  return DOMAIN_KEYS.has(key);
}
