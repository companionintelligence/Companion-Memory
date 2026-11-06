/**
 * Identifiers (PWS "Identifiers" section) and the reserved path segments of the Reserved Path
 * Segment Registry.
 *
 * The specification leaves the id format to the implementer and requires only URL-safety and
 * uniqueness within the parent. This server takes the narrowest reading: RFC 3986 unreserved
 * characters, 1 to 128 of them, and never `.` or `..`. Nothing else is ever percent-encoded, so a
 * path has exactly one spelling, which matters because a capability's `invocationTarget` and the
 * HTTP signature both cover the URL as a string.
 */
import { randomUUID } from 'node:crypto';

export const MAX_ID_LENGTH = 128;

const UNRESERVED = /^[A-Za-z0-9._~-]+$/;

export function isValidId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_ID_LENGTH &&
    UNRESERVED.test(id) &&
    id !== '.' &&
    id !== '..'
  );
}

/** Segments in the Collection position under a Space (`/space/{space_id}/{segment}`). */
export const SPACE_RESERVED = [
  'meta',
  'policy',
  'backends',
  'collections',
  'export',
  'import',
  'linkset',
  'query',
  'quotas',
] as const;

/** Segments in the Resource position under a Collection (`/space/{s}/{c}/{segment}`). */
export const COLLECTION_RESERVED = ['meta', 'policy', 'backend', 'linkset', 'query', 'quota'] as const;

/** Segments that qualify a Resource (`/space/{s}/{c}/{r}/{segment}`). */
export const RESOURCE_RESERVED = ['meta', 'policy', 'chunks'] as const;

export type SpaceReserved = (typeof SPACE_RESERVED)[number];
export type CollectionReserved = (typeof COLLECTION_RESERVED)[number];

export function isSpaceReserved(segment: string): segment is SpaceReserved {
  return (SPACE_RESERVED as readonly string[]).includes(segment);
}

export function isCollectionReserved(segment: string): segment is CollectionReserved {
  return (COLLECTION_RESERVED as readonly string[]).includes(segment);
}

export function generateId(): string {
  return randomUUID();
}
