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

/**
 * The scopes an api key may carry, mirroring the backend's `RequireScopes` constants.
 *
 * Kept here for the same reason as {@link API_KEY_PROVENANCE_CONNECT}: these are API contract
 * values, not UI copy. The create/update body is validated against exactly this list, so a literal
 * that drifted would 400 at creation with nothing in the dialog to explain why. The human-readable
 * label and description for each stay in the component, which is where copy belongs.
 */
export const API_KEY_SCOPE_MEMORY = 'memory';
export const API_KEY_SCOPE_INTENTS = 'intents';
export const API_KEY_SCOPE_MCP = 'mcp';
export const API_KEY_SCOPE_CAPTURE = 'capture';

/**
 * What a key may DO on the surfaces its scopes reach — the second, orthogonal axis (the backend's
 * `capability` column). Scopes decide WHICH tools a key sees; capability decides which of those it
 * may run.
 *
 * Same three values as CI-Hub uses for the same purpose. A user granting a connected agent access
 * to both appliances should meet one concept, not two dialects, so these literals are worth keeping
 * identical even though nothing forces them to be.
 */
export const API_KEY_CAPABILITY_READ = 'read';
export const API_KEY_CAPABILITY_WRITE = 'write';
export const API_KEY_CAPABILITY_FULL = 'full';

export const API_KEY_CAPABILITIES = [
  API_KEY_CAPABILITY_READ,
  API_KEY_CAPABILITY_WRITE,
  API_KEY_CAPABILITY_FULL,
] as const;

export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

/** What a key gets when nobody said — matches the column default, so the dialog opens on the level
 *  the server would have chosen anyway. */
export const DEFAULT_API_KEY_CAPABILITY: ApiKeyCapability = API_KEY_CAPABILITY_WRITE;

/** True when moving to `to` grants authority `from` did not have — the test for whether a change
 *  needs a confirmation. A demotion only ever removes authority. */
export function isApiKeyCapabilityPromotion(from: ApiKeyCapability, to: ApiKeyCapability): boolean {
  return API_KEY_CAPABILITIES.indexOf(to) > API_KEY_CAPABILITIES.indexOf(from);
}
