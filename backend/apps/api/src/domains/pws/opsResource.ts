/**
 * Operations on a Resource and its Metadata object: create (POST), read, replace (PUT, create-by-id),
 * delete, and the `/meta` pair.
 *
 * A Resource has exactly one representation: the stored bytes under the stored content type, and
 * every write replaces both. Bytes come back verbatim, so a JSON Resource is the very text the
 * client sent (it is parsed to check it, never re-serialized). Two validators are kept apart on
 * purpose: the Resource's own (`ETag` of the content) and the Metadata object's, because writing the
 * annotations must not change the content's write stamp or `ETag` (spec: "Update Resource Metadata").
 */
import { policyChain } from './context';
import type { OpContext } from './context';
import { emptyResponse, isJsonMediaType } from './http';
import type { PwsResponse } from './http';
import { assertWriteIsUnique } from './indexes';
import { bump, etagOf, newValidator } from './models';
import type { CollectionRecord, ResourceRecord, SpaceRecord } from './models';
import { requireCollection } from './opsCollection';
import { requireSpace } from './opsSpace';
import { PwsError, invalidBody, notFound } from './problems';
import { readLabelHeader, readResourceMetaBody } from './validate';
import { resourceMetaView } from './views';

interface Parents {
  space: SpaceRecord;
  collection: CollectionRecord;
  access: { invoker?: string; via: 'root' | 'delegated' | 'policy' };
}

/**
 * The Space, then authorization for the target, then the Collection. The Collection is looked up only for a
 * caller already allowed in, so no refusal (not even the typed `capability-expired`) depends on whether it
 * exists. The Resource itself need not exist: a write may create it.
 */
async function parents(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
  resourceId: string,
): Promise<Parents> {
  const space = await requireSpace(ctx, spaceId);
  const access = await ctx.authorize({
    spaceUrl: ctx.env.urls.spaceUrl(space.id),
    rootController: space.controller,
    policyChain: policyChain(space.id, collectionId, resourceId),
  });
  const collection = await requireCollection(ctx, spaceId, collectionId);

  return { space, collection, access };
}

/** The content type, size and JSON well-formedness of a content write. */
function readContent(ctx: OpContext): { contentType: string; bytes: Uint8Array } {
  const contentType = ctx.header('content-type');
  if (contentType === undefined || contentType.trim() === '') {
    throw new PwsError('missing-content-type', 'A Resource write needs a Content-Type header.');
  }

  const bytes = ctx.req.body;
  if (bytes.byteLength > ctx.env.maxUploadBytes) {
    throw new PwsError('payload-too-large', `A Resource may not exceed ${ctx.env.maxUploadBytes} bytes.`);
  }

  // The optional form-upload workflow is not implemented. Storing the multipart envelope as if it were
  // the file would hand an HTML-form client a Resource it never uploaded, so say so instead.
  if (/^multipart\/form-data\s*(;|$)/i.test(contentType)) {
    throw new PwsError(
      'unsupported-operation',
      'multipart/form-data uploads are not supported; upload the file itself as the request body and set its media type in Content-Type.',
    );
  }

  if (isJsonMediaType(contentType)) {
    try {
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw invalidBody('The body is not valid JSON for its declared content type.');
    }
  }

  return { contentType: contentType.trim(), bytes };
}

function contentHeaders(
  ctx: OpContext,
  resource: ResourceRecord,
  viaPolicy: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': resource.contentType,
    etag: etagOf(resource.validator),
    'cache-control': viaPolicy ? 'public, no-cache' : 'private, no-cache',
  };
  // User content is served from the API's own origin: keep a hosted HTML page from running there.
  if (ctx.env.resourceContentSecurityPolicy !== null) {
    headers['content-security-policy'] = ctx.env.resourceContentSecurityPolicy;
  }

  return headers;
}

/** `POST /space/{s}/{c}/`: add a Resource under an id the server chooses. */
export async function createResource(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
): Promise<PwsResponse> {
  const { urls } = ctx.env;
  // The id is only known once chosen; a policy cannot authorize a write, so the chain is for the 401 rule.
  const id = ctx.env.generateId();
  const parent = await parents(ctx, spaceId, collectionId, id);
  const { access } = parent;
  const { contentType, bytes } = readContent(ctx);
  const writerId = readLabelHeader(ctx.header('writer-id'), 'Writer-Id');
  const epoch = readLabelHeader(ctx.header('key-epoch'), 'Key-Epoch');
  // A `generateId` that repeats must not overwrite someone's Resource (Spaces and Collections check too).
  if (await ctx.tx.getResource(spaceId, collectionId, id)) {
    throw new PwsError('id-conflict', 'The identifier chosen for the new Resource is already in use.');
  }

  await assertWriteIsUnique(ctx.tx, {
    spaceId,
    collectionId,
    indexes: parent.collection.plaintext?.indexes,
    candidate: { id, contentType, bytes },
  });

  const now = ctx.now.toISOString();
  const resource: ResourceRecord = {
    spaceId,
    collectionId,
    id,
    contentType,
    bytes,
    createdBy: access.invoker ?? parent.space.controller,
    createdAt: now,
    stamp: ctx.stamp(),
    ...(writerId !== undefined ? { writerId } : {}),
    ...(epoch !== undefined ? { epoch } : {}),
    validator: newValidator(),
    metaValidator: newValidator(),
  };
  await ctx.tx.putResource(resource);

  return ctx.json(
    201,
    // `content-type` mirrors the stored type: the reference server returns it and its client reads it.
    { id, url: urls.resourcePath(spaceId, collectionId, id), 'content-type': contentType },
    { location: urls.resourceUrl(spaceId, collectionId, id), etag: etagOf(resource.validator) },
  );
}

/** `GET` / `HEAD` `/space/{s}/{c}/{r}`. */
export async function readResource(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
  resourceId: string,
): Promise<PwsResponse> {
  const { access } = await parents(ctx, spaceId, collectionId, resourceId);
  const resource = await ctx.tx.getResource(spaceId, collectionId, resourceId);
  if (!resource) {
    throw notFound();
  }

  const headers = contentHeaders(ctx, resource, access.via === 'policy');
  if (ctx.precondition(headers.etag) === 'not-modified') {
    // RFC 9110 section 15.4.5: a 304 repeats the Cache-Control the 200 would have carried.
    return emptyResponse(304, {
      etag: headers.etag as string,
      'cache-control': headers['cache-control'] as string,
    });
  }

  headers['content-length'] = String(resource.bytes.byteLength);

  return { status: 200, headers, body: resource.bytes };
}

/** `PUT /space/{s}/{c}/{r}`: replace the representation, or create the Resource at this id. */
export async function putResource(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
  resourceId: string,
): Promise<PwsResponse> {
  const parent = await parents(ctx, spaceId, collectionId, resourceId);
  const { access } = parent;
  const { contentType, bytes } = readContent(ctx);
  const writerId = readLabelHeader(ctx.header('writer-id'), 'Writer-Id');
  const epoch = readLabelHeader(ctx.header('key-epoch'), 'Key-Epoch');

  const existing = await ctx.tx.getResource(spaceId, collectionId, resourceId);
  ctx.precondition(existing ? etagOf(existing.validator) : undefined);
  await assertWriteIsUnique(ctx.tx, {
    spaceId,
    collectionId,
    indexes: parent.collection.plaintext?.indexes,
    candidate: { id: resourceId, contentType, bytes },
  });

  const now = ctx.now.toISOString();
  const resource: ResourceRecord = {
    spaceId,
    collectionId,
    id: resourceId,
    contentType,
    bytes,
    createdBy: existing?.createdBy ?? access.invoker ?? parent.space.controller,
    createdAt: existing?.createdAt ?? now,
    stamp: ctx.stamp(existing?.stamp),
    // The Metadata object's own stamp belongs to the metadata, not the content: a content write keeps it.
    ...(existing?.metaStamp ? { metaStamp: existing.metaStamp } : {}),
    // A content write declares its own labels or clears the stored ones.
    ...(writerId !== undefined ? { writerId } : {}),
    ...(epoch !== undefined ? { epoch } : {}),
    // The annotations are the Metadata object's, not the content's: a content write keeps them.
    ...(existing?.custom ? { custom: existing.custom } : {}),
    validator: existing ? bump(existing.validator) : newValidator(),
    // The Metadata object's body mixes content-derived members (contentType, size, stamp, writerId, epoch) with
    // the annotations, so a content write must move its strong validator too (RFC 9110 section 8.8.1).
    metaValidator: existing ? bump(existing.metaValidator) : newValidator(),
  };
  await ctx.tx.putResource(resource);

  return emptyResponse(204, { etag: etagOf(resource.validator) });
}

/** `DELETE /space/{s}/{c}/{r}`. Idempotent for an authorized caller. */
export async function deleteResource(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
  resourceId: string,
): Promise<PwsResponse> {
  await parents(ctx, spaceId, collectionId, resourceId);
  readLabelHeader(ctx.header('writer-id'), 'Writer-Id');
  const existing = await ctx.tx.getResource(spaceId, collectionId, resourceId);
  ctx.precondition(existing ? etagOf(existing.validator) : undefined);
  if (existing) {
    await ctx.tx.deleteResource(spaceId, collectionId, resourceId);
  }

  return emptyResponse(204);
}

/** `GET` / `HEAD` `/space/{s}/{c}/{r}/meta`. */
export async function readResourceMeta(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
  resourceId: string,
): Promise<PwsResponse> {
  await parents(ctx, spaceId, collectionId, resourceId);
  const resource = await ctx.tx.getResource(spaceId, collectionId, resourceId);
  if (!resource) {
    throw notFound();
  }

  const etag = etagOf(resource.metaValidator);
  if (ctx.precondition(etag) === 'not-modified') {
    return emptyResponse(304, { etag });
  }

  return ctx.json(200, resourceMetaView(resource), { etag });
}

/**
 * `PUT /space/{s}/{c}/{r}/meta`: replace the user-writable `custom` object and optionally set the
 * `epoch` stamp. Never creates, and never touches the content's write stamp or `ETag`.
 */
export async function putResourceMeta(
  ctx: OpContext,
  spaceId: string,
  collectionId: string,
  resourceId: string,
): Promise<PwsResponse> {
  await parents(ctx, spaceId, collectionId, resourceId);
  const existing = await ctx.tx.getResource(spaceId, collectionId, resourceId);
  if (!existing) {
    throw notFound();
  }

  const input = readResourceMetaBody(ctx.jsonBody());
  ctx.precondition(etagOf(existing.metaValidator));

  const updated: ResourceRecord = {
    ...existing,
    metaValidator: bump(existing.metaValidator),
    metaStamp: ctx.stamp(existing.metaStamp),
    // An omitted `epoch` preserves the stamp (it describes the content write); `custom` is replaced.
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
  };
  delete updated.custom;
  if (input.custom && (input.custom.name !== undefined || input.custom.tags !== undefined)) {
    updated.custom = input.custom;
  }

  await ctx.tx.putResource(updated);

  return emptyResponse(204, { etag: etagOf(updated.metaValidator) });
}
