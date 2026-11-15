/**
 * Projections of stored records into the documents the specification defines: the Space and
 * Collection Metadata objects, the Resource Metadata object, the list envelopes and the linksets.
 *
 * The Metadata objects carry exactly the members the specification names. A client that
 * round-trips one (read, edit, write back) must be able to send server-derived members without
 * stripping them, so the write paths ignore them (see `handler`), and nothing else is added here:
 * the conformance suite compares these shapes exactly.
 */
import type { JsonObject } from './dataIntegrity';
import { etagOf } from './models';
import type { CollectionRecord, ResourceRecord, SpaceRecord } from './models';
import type { PwsUrls } from './routes';
import type { Stamp } from './stamp';

/** The three write-stamp members of a record (see `stamp.ts`). */
function stampView(stamp: Stamp): JsonObject {
  return { updatedAt: stamp.updatedAt, updatedAtCounter: stamp.updatedAtCounter, originId: stamp.originId };
}

export function spaceView(urls: PwsUrls, space: SpaceRecord): JsonObject {
  return {
    id: space.id,
    url: urls.spacePath(space.id),
    type: space.type,
    ...(space.name !== undefined ? { name: space.name } : {}),
    controller: space.controller,
    createdBy: space.createdBy,
    ...stampView(space.stamp),
    linkset: urls.path(`space/${space.id}/linkset`),
  };
}

export function collectionView(urls: PwsUrls, collection: CollectionRecord): JsonObject {
  const { spaceId, id } = collection;

  return {
    id,
    url: urls.collectionPath(spaceId, id),
    type: collection.type,
    ...(collection.name !== undefined ? { name: collection.name } : {}),
    createdAt: collection.createdAt,
    ...stampView(collection.stamp),
    createdBy: collection.createdBy,
    ...(collection.generator ? { generator: { ...collection.generator } } : {}),
    linkset: urls.path(`space/${spaceId}/${id}/linkset`),
    backend: { ...collection.backend },
    ...(collection.plaintext ? { plaintext: plaintextView(collection.plaintext) } : {}),
    ...(collection.custom ? { custom: customView(collection.custom) } : {}),
    ...(collection.epoch !== undefined ? { epoch: collection.epoch } : {}),
  };
}

/** The declaration is echoed as it was written: a bare name stays a bare name. */
function plaintextView(plaintext: NonNullable<CollectionRecord['plaintext']>): JsonObject {
  return plaintext.indexes
    ? { indexes: plaintext.indexes.map((entry) => (typeof entry === 'string' ? entry : { ...entry })) }
    : {};
}

function customView(custom: NonNullable<CollectionRecord['custom']>): JsonObject {
  return {
    ...(custom.name !== undefined ? { name: custom.name } : {}),
    ...(custom.tags !== undefined ? { tags: custom.tags } : {}),
  };
}

export function resourceMetaView(resource: ResourceRecord): JsonObject {
  return {
    contentType: resource.contentType,
    size: resource.bytes.byteLength,
    createdAt: resource.createdAt,
    // The content record's stamp; a write of the metadata leaves it alone.
    ...stampView(resource.stamp),
    createdBy: resource.createdBy,
    ...(resource.writerId !== undefined ? { writerId: resource.writerId } : {}),
    ...(resource.epoch !== undefined ? { epoch: resource.epoch } : {}),
    ...(resource.custom ? { custom: customView(resource.custom) } : {}),
    // Once the metadata has been written it has a record, and so a stamp, of its own.
    ...(resource.metaStamp
      ? { meta: { ...stampView(resource.metaStamp), generation: resource.validator.nonce } }
      : {}),
  };
}

export function spaceListItem(urls: PwsUrls, space: SpaceRecord): JsonObject {
  return {
    id: space.id,
    url: urls.spacePath(space.id),
    type: space.type,
    ...(space.name !== undefined ? { name: space.name } : {}),
  };
}

/** A Collection in a Space listing. `name` defaults to the id; `public` is always explicit. */
export function collectionListItem(
  urls: PwsUrls,
  collection: CollectionRecord,
  isPublic: boolean,
): JsonObject {
  return {
    id: collection.id,
    url: urls.collectionPath(collection.spaceId, collection.id),
    name: collection.name ?? collection.id,
    public: isPublic,
  };
}

export function resourceListItem(urls: PwsUrls, resource: ResourceRecord): JsonObject {
  return {
    id: resource.id,
    url: urls.resourcePath(resource.spaceId, resource.collectionId, resource.id),
    ...(resource.custom?.name !== undefined ? { name: resource.custom.name } : {}),
    contentType: resource.contentType,
    ...(resource.epoch !== undefined ? { epoch: resource.epoch } : {}),
    ...(resource.writerId !== undefined ? { writerId: resource.writerId } : {}),
  };
}

const POLICY_REL = 'https://w3id.org/pws#policy';

/** `application/linkset+json` (RFC 9264) for a Space or a Collection. */
export function linkset(urls: PwsUrls, anchor: string, policyPath: string): JsonObject {
  return {
    linkset: [
      {
        anchor,
        [POLICY_REL]: [{ href: policyPath, type: 'application/json' }],
        service: [{ href: urls.serviceUrl(), type: 'application/json' }],
      },
    ],
  };
}

export { etagOf };
