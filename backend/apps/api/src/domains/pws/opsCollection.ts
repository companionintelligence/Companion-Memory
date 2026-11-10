/**
 * Operations on a Collection: create (POST to the Space, or create-by-PUT of its Metadata object),
 * read and replace the Metadata object, delete, and list its Resources.
 *
 * A Collection's Metadata object is a full replacement on `PUT`, with four deliberate exceptions the
 * specification names: an omitted `backend` keeps the stored backend (clearing it would strand every
 * stored Resource), and an omitted `generator` or `plaintext` keeps its stored value. Everything
 * else an update leaves out is cleared. The server-derived members are ignored when sent.
 */
import { collectionMetaException } from './access';
import { policyChain } from './context';
import type { OpContext } from './context';
import { emptyResponse } from './http';
import type { PwsResponse } from './http';
import { isSpaceReserved } from './ids';
import { assertDeclarationHolds, assertEnforceable } from './indexes';
import { bump, etagOf, newValidator } from './models';
import type { CollectionRecord } from './models';
import { requireSpace } from './opsSpace';
import { nextLink, readPageRequest } from './pagination';
import { PwsError, invalidBody, notFound } from './problems';
import { readCollectionBody, requireUrlSafeId } from './validate';
import type { CollectionInput } from './validate';
import { collectionView, resourceListItem } from './views';

export async function requireCollection(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
): Promise<CollectionRecord> {
  const collection = await ctx.tx.getCollection(spaceId, collectionId);
  if (!collection) {
    throw notFound();
  }

  return collection;
}

/** The checks both create paths share, after the caller is authorized and before anything is written. */
function checkSupported(input: CollectionInput): void {
  if (input.encryption) {
    throw new PwsError(
      'unsupported-encryption-scheme',
      'This server does not implement client-side encrypted Collections; declare no "encryption" member.',
    );
  }

  if (input.backend && input.backend.id !== 'default') {
    throw new PwsError(
      'unsupported-backend',
      `The backend "${input.backend.id}" is not available in this Space.`,
    );
  }

  assertEnforceable(input.plaintext?.indexes);
}

function etagHeader(validator: CollectionRecord['validator']): Record<string, string> {
  return { etag: etagOf(validator) };
}

/** `POST /space/{s}/`: add a Collection. */
export async function createCollection(ctx: OpContext, spaceId: string): Promise<PwsResponse> {
  const { urls } = ctx.env;
  const space = await requireSpace(ctx, spaceId);
  const access = await ctx.authorize({
    spaceUrl: urls.spaceUrl(spaceId),
    rootController: space.controller,
    policyChain: policyChain(spaceId),
  });

  const input = readCollectionBody(ctx.jsonBody());
  const id = input.id ?? ctx.env.generateId();
  if (input.id !== undefined) {
    requireUrlSafeId(input.id, '/id');
    if (isSpaceReserved(id)) {
      throw new PwsError('reserved-id', `"${id}" is a reserved path segment and cannot name a Collection.`);
    }
  }

  checkSupported(input);
  // Only now, with the caller authorized, may a conflict be reported (it confirms the id exists).
  if (await ctx.tx.getCollection(spaceId, id)) {
    throw new PwsError('id-conflict', 'A Collection with this id already exists.');
  }

  const collection = await insertCollection(ctx, spaceId, id, input, access.invoker ?? space.controller);

  return ctx.json(201, collectionView(urls, collection), {
    location: urls.collectionUrl(spaceId, id),
    ...etagHeader(collection.validator),
  });
}

async function insertCollection(
  ctx: OpContext,
  spaceId: string,
  id: string,
  input: CollectionInput,
  createdBy: string,
): Promise<CollectionRecord> {
  const now = ctx.now.toISOString();
  const collection: CollectionRecord = {
    spaceId,
    id,
    type: input.type,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.generator ? { generator: input.generator } : {}),
    backend: input.backend ?? { id: 'default' },
    ...(input.plaintext ? { plaintext: input.plaintext } : {}),
    ...(input.custom ? { custom: input.custom } : {}),
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
    createdBy,
    createdAt: now,
    stamp: ctx.stamp(),
    validator: newValidator(),
  };
  await ctx.tx.putCollection(collection);

  return collection;
}

/** `GET /space/{s}/{c}/meta`. */
export async function readCollection(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
): Promise<PwsResponse> {
  const space = await requireSpace(ctx, spaceId);
  const collection = await ctx.tx.getCollection(spaceId, collectionId);
  await ctx.authorize({
    spaceUrl: ctx.env.urls.spaceUrl(spaceId),
    rootController: space.controller,
    policyChain: policyChain(spaceId, collectionId),
  });
  if (!collection) {
    throw notFound();
  }

  const etag = etagOf(collection.validator);
  if (ctx.precondition(etag) === 'not-modified') {
    return emptyResponse(304, { etag });
  }

  return ctx.json(200, collectionView(ctx.env.urls, collection), { etag });
}

/** `PUT /space/{s}/{c}/meta`: replace the Metadata object, or create the Collection at this id. */
export async function putCollection(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
): Promise<PwsResponse> {
  const { urls } = ctx.env;
  const space = await requireSpace(ctx, spaceId);
  const spaceUrl = urls.spaceUrl(spaceId);
  const access = await ctx.authorize({
    spaceUrl,
    rootController: space.controller,
    // The container rule: the controller, or a grant on the Space or on this Collection itself.
    rule: {
      kind: 'root-or',
      delegated: collectionMetaException(spaceUrl, urls.collectionUrl(spaceId, collectionId)),
    },
    policyChain: policyChain(spaceId, collectionId),
  });

  const input = readCollectionBody(ctx.jsonObjectBody());
  if (input.id !== undefined && input.id !== collectionId) {
    throw invalidBody('"id" must match the Collection in the URL.', '/id');
  }

  const existing = await ctx.tx.getCollection(spaceId, collectionId);
  // The exclusion is on the resulting object, so a stored `plaintext` counts too (even an empty one).
  if (input.encryption && existing?.plaintext) {
    throw invalidBody(
      'The resulting object would carry both "plaintext" and "encryption"; they are mutually exclusive.',
      '/encryption',
    );
  }

  checkSupported(input);
  ctx.precondition(existing ? etagOf(existing.validator) : undefined);

  if (!existing) {
    const created = await insertCollection(
      ctx,
      spaceId,
      collectionId,
      input,
      access.invoker ?? space.controller,
    );

    return ctx.json(201, collectionView(urls, created), {
      location: urls.collectionUrl(spaceId, collectionId),
      ...etagHeader(created.validator),
    });
  }

  const plaintext = input.plaintext ?? existing.plaintext;
  if (input.plaintext) {
    await assertDeclarationHolds(ctx.tx, { spaceId, collectionId, indexes: input.plaintext.indexes });
  }

  const generator = input.generator ?? existing.generator;
  // A full replacement: what the request omits is cleared, except the three kept members
  // (`backend`, `generator`, `plaintext`) and the creation facts.
  const updated: CollectionRecord = {
    spaceId,
    id: collectionId,
    type: input.type,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(generator ? { generator } : {}),
    backend: input.backend ?? existing.backend,
    ...(plaintext ? { plaintext } : {}),
    ...(input.custom ? { custom: input.custom } : {}),
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    stamp: ctx.stamp(existing.stamp),
    validator: bump(existing.validator),
  };
  await ctx.tx.putCollection(updated);

  return emptyResponse(204, etagHeader(updated.validator));
}

/** `DELETE /space/{s}/{c}/`: controller-only, never delegable. Idempotent for an authorized caller. */
export async function deleteCollection(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
): Promise<PwsResponse> {
  const space = await requireSpace(ctx, spaceId);
  await ctx.authorize({
    spaceUrl: ctx.env.urls.spaceUrl(spaceId),
    rootController: space.controller,
    rule: { kind: 'root' },
    policyChain: policyChain(spaceId, collectionId),
  });
  const existing = await ctx.tx.getCollection(spaceId, collectionId);
  ctx.precondition(existing ? etagOf(existing.validator) : undefined);
  await ctx.tx.deleteCollection(spaceId, collectionId);

  return emptyResponse(204);
}

/** `GET /space/{s}/{c}/`: the Collection's Resources. */
export async function listResources(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
): Promise<PwsResponse> {
  const { urls } = ctx.env;
  const space = await requireSpace(ctx, spaceId);
  await ctx.authorize({
    spaceUrl: urls.spaceUrl(spaceId),
    rootController: space.controller,
    policyChain: policyChain(spaceId, collectionId),
  });
  const collection = await requireCollection(ctx, spaceId, collectionId);

  const scope = urls.collectionPath(spaceId, collectionId);
  const page = readPageRequest(ctx.url.searchParams, scope, ctx.env.page);
  const listed = await ctx.tx.listResources(spaceId, collectionId, {
    limit: page.limit,
    ...(page.after !== undefined ? { after: page.after } : {}),
  });
  const last = listed.items[listed.items.length - 1];

  return ctx.json(200, {
    id: collection.id,
    url: scope,
    name: collection.name ?? collection.id,
    type: collection.type,
    totalItems: await ctx.tx.countResources(spaceId, collectionId),
    items: listed.items.map((resource) => resourceListItem(urls, resource)),
    ...(listed.hasMore && last ? { next: nextLink(scope, page.limit, last.id) } : {}),
  });
}
