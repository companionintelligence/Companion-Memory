export const ENTITY_TYPE_REVERSE_MAP = {
  'browser-activity': 'Browser',
  communication: 'Communication',
  content: 'Content',
  event: 'Event',
  file: 'File',
  note: 'Note',
  person: 'Person',
  place: 'Place',
  item: 'Thing',
};

export const ENTITY_TYPE_MAP = {
  Browser: 'browser-activity',
  Communication: 'communication',
  Content: 'content',
  Event: 'event',
  File: 'file',
  Note: 'note',
  Person: 'person',
  Place: 'place',
  Thing: 'item',
};

/**
 * `managed_by` value the API stamps on an api key minted by the Companion Memory
 * consent flow. CI-Hub owns such a key's lifecycle (it rotates and revokes it), so
 * the settings UI badges it and blocks renaming.
 *
 * The API contract value, kept here rather than inline in a component: the backend
 * enforces on this literal, and if the two ever disagreed the UI would offer an Edit
 * button the API rejects — the exact drift the provenance column removed.
 */
export const API_KEY_PROVENANCE_CONNECT = 'connect';
