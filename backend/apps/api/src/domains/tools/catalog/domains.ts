/**
 * CI Schema Domains — the standardized capability vocabulary.
 *
 * A small, curated set of domains that tools are grouped under, so an assistant reliably maps
 * natural language to an action and CI-Hermes, CI-OpenClaw, and any MCP client use the same verbs
 * instead of inventing their own per-harness tool names.
 */

import type { IntentDomainKey } from '../core/types';

import type { IntentDomain } from './types';

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
  {
    key: 'import',
    title: 'Import',
    description:
      'Discover what an export archive holds, bring it into the personal corpus, and follow the import.',
  },
  {
    key: 'forecast',
    title: 'Forecast',
    description: 'Read the day-ahead behavior forecast and its calibration.',
  },
  {
    key: 'brief',
    title: 'Brief',
    description: 'List insights, anomalies, and open actions waiting in Brief.',
  },
  {
    key: 'insights',
    title: 'Insights',
    description: 'Explain computed associations over daily metrics, with evidence.',
  },
  {
    key: 'anomalies',
    title: 'Anomalies',
    description: 'List computed metric and behavioral anomalies.',
  },
  {
    key: 'suggestions',
    title: 'Suggestions',
    description: 'List evidence-linked suggestions and record accept/dismiss feedback.',
  },
  {
    key: 'messaging',
    title: 'Messaging',
    description: 'Send and read messages through connected messaging services.',
  },
  {
    key: 'mcp',
    title: 'MCP Tools',
    description: 'Tools exposed by connected external Model Context Protocol servers.',
  },
  {
    key: 'planning',
    title: 'Planning',
    description: 'Find and create tasks in the personal to-do list.',
  },
] as const;

const DOMAIN_KEYS = new Set<string>(INTENT_DOMAINS.map((d) => d.key));

/** True if `key` is a registered CI schema domain. */
export function isIntentDomain(key: string): key is IntentDomainKey {
  return DOMAIN_KEYS.has(key);
}
