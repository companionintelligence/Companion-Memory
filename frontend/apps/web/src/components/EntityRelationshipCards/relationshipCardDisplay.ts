import { HOUR_MINUTE, type DateTimeFormatter } from '@/lib/dateTimeFormat';
import { labelForSource } from '@/lib/sourceNames';
import { formatEnumLabel } from '@/lib/utils';

/**
 * Keys that are graph/pipeline bookkeeping. Dumping the first two properties
 * used to print `Connection Id: 019f…` and `Normalized From: RECEIVED_EMAIL_FROM`
 * on every email-derived card.
 */
const TECHNICAL_PROPERTY_KEYS = new Set([
  'id',
  'relationship_id',
  'relationshipId',
  'connection_id',
  'connectionId',
  'source',
  'target',
  'from_entity_id',
  'to_entity_id',
  'from_entity_type',
  'to_entity_type',
  'owner_user_id',
  'user_id',
  'userId',
  'communication_id',
  'communicationId',
  'source_communication_id',
  'sourceCommunicationId',
  'source_id',
  'sourceId',
  'created_at',
  'updated_at',
  'normalized_from',
  'normalizedFrom',
  'normalized_duplicate_of',
  'rejected',
  'importer',
  'pipeline',
  'detector',
  'generation',
  'version',
  'strength',
  'weight',
  'score',
  'confidence',
]);

const HUMAN_SUMMARY_KEYS = [
  'preview',
  'snippet',
  'body_preview',
  'bodyPreview',
  'subject',
  'title',
  'note',
  'notes',
  'context',
  'role',
  'location',
  'channel',
];

/**
 * Gmail system labels and graph type tokens that leak onto communication
 * nodes. None of these tell a person anything they cannot already see from
 * the title and the kind badge.
 */
const NOISE_TAGS = new Set([
  'inbox',
  'sent',
  'draft',
  'drafts',
  'unread',
  'starred',
  'spam',
  'trash',
  'important',
  'chat',
  'yellow_star',
  'category_personal',
  'category_promotions',
  'category_social',
  'category_updates',
  'category_forums',
  'person',
  'place',
  'communication',
  'content',
  'event',
  'item',
  'note',
  'file',
  'concept',
  'product',
  'receipt',
  'thread',
]);

/**
 * Edge types that are residual after import/normalize. Showing "Associated
 * With" next to a name is not more informative than the name itself.
 */
const LOW_VALUE_RELATIONSHIP_TYPES = new Set(['ASSOCIATED_WITH', 'RELATED_TO', 'RELATES_TO', 'IS']);

type DirectedPhrase = {
  /** Focus entity is the edge source (typical write direction). */
  asSource: string;
  /** Focus entity is the edge target. */
  asTarget: string;
};

/**
 * Reader-facing phrases from the page they are standing on. Direction matters
 * for mail: `RECEIVED_EMAIL_FROM` is swapped to `EMAILED` at normalize time,
 * so a neighbor who is the *source* of `EMAILED` is the one who wrote.
 */
const RELATIONSHIP_PHRASES: Record<string, DirectedPhrase> = {
  EMAILED: { asSource: 'You emailed', asTarget: 'Emailed you' },
  RECEIVED_EMAIL_FROM: { asSource: 'Emailed you', asTarget: 'You emailed' },
  SENT: { asSource: 'You sent this', asTarget: 'Sent to you' },
  RECEIVED: { asSource: 'You received this', asTarget: 'Received from you' },
  MESSAGED: { asSource: 'You messaged', asTarget: 'Messaged you' },
  CALLED: { asSource: 'You called', asTarget: 'Called you' },
  COMMUNICATES_WITH: { asSource: 'You write to each other', asTarget: 'You write to each other' },
  KNOWS: { asSource: 'Someone you know', asTarget: 'Knows you' },
  FRIENDS_WITH: { asSource: 'Friend', asTarget: 'Friend' },
  PARTNER_OF: { asSource: 'Partner', asTarget: 'Partner' },
  FAMILY_MEMBER: { asSource: 'Family', asTarget: 'Family' },
  WORKS_WITH: { asSource: 'Works with you', asTarget: 'Works with you' },
  COLLABORATED_WITH: { asSource: 'Collaborated', asTarget: 'Collaborated' },
  INDUSTRY_CONNECTION: { asSource: 'Industry connection', asTarget: 'Industry connection' },
  SHARES_INTERESTS_WITH: { asSource: 'Shares interests', asTarget: 'Shares interests' },
  MENTORED: { asSource: 'You mentored', asTarget: 'Mentored you' },
  TAUGHT: { asSource: 'You taught', asTarget: 'Taught you' },
  LEARNED_FROM: { asSource: 'You learned from', asTarget: 'Learned from you' },
  CARES_FOR: { asSource: 'You care for', asTarget: 'Cares for you' },
  CLIENT_OF: { asSource: 'Your client', asTarget: 'Their client' },
  EMERGENCY_CONTACT_FOR: { asSource: 'Emergency contact', asTarget: 'Lists you as emergency contact' },
  SUPPORTS: { asSource: 'You support', asTarget: 'Supports you' },
  EMPLOYS: { asSource: 'You employ', asTarget: 'Employs you' },
  LIVES_WITH: { asSource: 'Lives with you', asTarget: 'Lives with you' },
  MET_WITH: { asSource: 'You met', asTarget: 'Met you' },
  SPOUSE: { asSource: 'Spouse', asTarget: 'Spouse' },
  PARENT_OF: { asSource: 'Their parent', asTarget: 'Your parent' },
  CHILD_OF: { asSource: 'Their child', asTarget: 'Your child' },
  SIBLING_OF: { asSource: 'Sibling', asTarget: 'Sibling' },
  LIVES_IN: { asSource: 'Lives here', asTarget: 'Home' },
  STUDIES_AT: { asSource: 'Studies here', asTarget: 'School' },
  WORKS_AT: { asSource: 'Works here', asTarget: 'Workplace' },
  LIVES_NEAR: { asSource: 'Lives nearby', asTarget: 'Nearby' },
  VISITED: { asSource: 'Visited', asTarget: 'Visited' },
  OWNS: { asSource: 'Owns this', asTarget: 'Owned' },
  CREATED: { asSource: 'Created this', asTarget: 'Created' },
  PREFERS: { asSource: 'Prefers', asTarget: 'Prefers' },
  DISLIKES: { asSource: 'Dislikes', asTarget: 'Dislikes' },
  INTERESTED_IN: { asSource: 'Interested in', asTarget: 'Interested in' },
  PARTICIPATED_IN: { asSource: 'Participated', asTarget: 'They participated' },
  DOCUMENTS: { asSource: 'Part of this', asTarget: 'Includes this' },
  ORGANIZED_EVENT_WITH: { asSource: 'Organized an event with', asTarget: 'Organized an event with' },
  EDITED_WITH: { asSource: 'Edited with', asTarget: 'Edited with' },
};

function normalizeTag(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function firstNonEmptyString(properties: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!properties) {
    return null;
  }

  for (const key of keys) {
    const value = properties[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return null;
}

function clipText(value: string, max = 120): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function isTechnicalPropertyKey(key: string): boolean {
  if (TECHNICAL_PROPERTY_KEYS.has(key)) {
    return true;
  }

  return /(_id|Id|ID)$/.test(key);
}

export function formatNeighborKind(entityType: string, properties?: Record<string, unknown>): string {
  const normalized = entityType.toLowerCase().replace(/_/g, '-');

  if (normalized === 'communication') {
    const channel = firstNonEmptyString(properties, ['type', 'channel']);
    if (channel) {
      return labelForSource(channel);
    }

    return 'Message';
  }

  return formatEnumLabel(entityType.replace(/-/g, '_'));
}

/**
 * How this neighbor relates to the page the reader is on. Uses the live edge
 * type, then `normalized_from` when the live type was collapsed to something
 * generic (email aliases become `EMAILED`).
 */
export function formatRelationshipPhrase(
  relationshipType: string,
  options: {
    focusIsSource: boolean;
    relationshipProperties?: Record<string, unknown>;
  },
): string | null {
  const normalizedFrom = firstNonEmptyString(options.relationshipProperties, [
    'normalized_from',
    'normalizedFrom',
  ]);
  const raw =
    LOW_VALUE_RELATIONSHIP_TYPES.has(relationshipType.toUpperCase()) && normalizedFrom
      ? normalizedFrom
      : relationshipType;
  const key = raw.toUpperCase();

  if (LOW_VALUE_RELATIONSHIP_TYPES.has(key)) {
    return null;
  }

  const directed = RELATIONSHIP_PHRASES[key];
  if (directed) {
    return options.focusIsSource ? directed.asSource : directed.asTarget;
  }

  return formatEnumLabel(raw);
}

export function pickCardSummary(input: {
  name: string;
  description: string | null;
  entityProperties?: Record<string, unknown>;
}): string | null {
  const description = input.description?.trim();
  if (description && description !== input.name) {
    return clipText(description);
  }

  const fromProperties = firstNonEmptyString(input.entityProperties, HUMAN_SUMMARY_KEYS);
  if (fromProperties && fromProperties !== input.name) {
    return clipText(fromProperties);
  }

  return null;
}

export function filterDisplayTags(tags: string[], entityType: string): string[] {
  const entityKey = normalizeTag(entityType);

  return tags.filter((tag) => {
    const key = normalizeTag(tag);
    if (key.length === 0) {
      return false;
    }

    if (key === entityKey || NOISE_TAGS.has(key) || key.startsWith('category_')) {
      return false;
    }

    return true;
  });
}

export function formatCardWhen(
  recencyMs: number,
  fmt: DateTimeFormatter,
  now: Date = new Date(),
): string | null {
  if (!Number.isFinite(recencyMs) || recencyMs <= 0) {
    return null;
  }

  const date = new Date(recencyMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return fmt.time(date, HOUR_MINUTE, 'en-US');
  }

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
