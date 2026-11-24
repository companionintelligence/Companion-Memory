/**
 * Operations on the Spaces Repository and on a Space: create (POST and create-by-PUT), read, update,
 * delete, and the listing of a Space's Collections.
 *
 * The one place the specification lets a caller learn something about existence is Create Space: it
 * is the single operation whose invocation is verified against a `controller` the *body* supplies,
 * because the Space does not exist yet. That is why it checks for an existing id before it writes
 * anything and answers `id-conflict`: a server that treated `POST /spaces/` as create-or-replace
 * would let anyone with a valid invocation for their own controller overwrite an existing Space.
 */
import { collectionMetaException, decide, deleteSpaceException } from './access';
import type { Authn } from './authn';
import { policyChain } from './context';
import type { OpContext } from './context';
import { requireControllerAcceptable } from './controller';
import type { JsonObject } from './dataIntegrity';
import { emptyResponse } from './http';
import type { PwsResponse } from './http';
import { etagOf, newValidator, bump } from './models';
import type { SpaceRecord } from './models';
import { nextLink, readPageRequest } from './pagination';
import { PwsError, invalidBody, notFound } from './problems';
import { readSpaceBody, requireUrlSafeId } from './validate';
import { collectionListItem, spaceListItem, spaceView } from './views';
import type { DenialReason } from './zcap';

/** `controller-mismatch` details that tell the three delegated-create failures apart. */
const MISMATCH_DETAIL: Partial<Record<DenialReason, string>> = {
  'delegator-not-controller':
    'The delegation chain is rooted in a DID other than the controller named in the request body.',
  expired: 'A capability in the delegation chain has expired.',
  'bad-proof': 'A delegation proof in the chain failed verification.',
  'invoker-not-controller': 'The invoker is not the controller named in the request body.',
  'root-not-accepted': 'The invoked root capability does not belong to this request.',
};

export function requireSpace(ctx: OpContext, spaceId: string): Promise<SpaceRecord> {
  return ctx.tx.getSpace(spaceId).then((space) => {
    if (!space) {
      throw notFound();
    }

    return space;
  });
}

function etagHeader(validator: SpaceRecord['validator']): Record<string, string> {
  return { etag: etagOf(validator) };
}

/**
 * Whether the request is authorized *by the controller the body names*: signed by it, or carrying a
 * valid chain delegated from it. Used only where no Space exists yet to name a controller.
 */
async function authorizedByProposedController(
  ctx: OpContext,
  scopeUrl: string,
  controller: string,
): Promise<{ invoker: string }> {
  const authn: Authn = ctx.authn;
  if (authn.kind !== 'signed') {
    throw new PwsError('missing-authorization', 'Creating a Space requires a capability invocation.');
  }

  const decision = await decide({
    authn,
    env: ctx.accessEnv(scopeUrl, controller),
    rule: { kind: 'any' },
    policyRead: async () => false,
  });
  if (!decision.ok || decision.invoker === undefined) {
    const detail =
      (!decision.ok && decision.reason && MISMATCH_DETAIL[decision.reason]) ||
      'The request is not authorized by the controller in the body.';
    throw new PwsError('controller-mismatch', detail);
  }

  return { invoker: decision.invoker };
}

// --- Spaces Repository -----------------------------------------------------------------------

/** `GET /spaces/`: the Spaces the invoker controls. No credential, or none that lists any, is an empty list. */
export async function listSpaces(ctx: OpContext): Promise<PwsResponse> {
  const { urls } = ctx.env;
  const scope = urls.path('spaces/');
  const empty = (): PwsResponse => ctx.json(200, { url: scope, totalItems: 0, items: [] });

  if (ctx.authn.kind !== 'signed') {
    return empty();
  }

  // The root of `/spaces/` has no controller of its own: the invoker is, by the act of invoking it.
  const decision = await decide({
    authn: ctx.authn,
    env: ctx.accessEnv(urls.spacesUrl(), ctx.authn.invoker.did),
    rule: { kind: 'root' },
    policyRead: async () => false,
  });
  if (!decision.ok || decision.invoker === undefined) {
    return empty();
  }

  const page = readPageRequest(ctx.url.searchParams, scope, ctx.env.page);
  const listed = await ctx.tx.listSpaces({
    controller: decision.invoker,
    limit: page.limit,
    ...(page.after !== undefined ? { after: page.after } : {}),
  });
  const last = listed.items[listed.items.length - 1];

  return ctx.json(200, {
    url: scope,
    totalItems: await ctx.tx.countSpaces(decision.invoker),
    items: listed.items.map((space) => spaceListItem(urls, space)),
    ...(listed.hasMore && last ? { next: nextLink(scope, page.limit, last.id) } : {}),
  });
}

/** `POST /spaces/`. */
export async function createSpace(ctx: OpContext): Promise<PwsResponse> {
  const { urls } = ctx.env;
  if (ctx.authn.kind !== 'signed') {
    throw new PwsError('missing-authorization', 'Creating a Space requires a capability invocation.');
  }

  const input = readSpaceBody(ctx.jsonBody());
  if (input.controller === undefined) {
    throw invalidBody('A "controller" DID is required.', '/controller');
  }

  const controller = input.controller;
  await requireControllerAcceptable(ctx.env.keys, controller);

  const id = input.id ?? ctx.env.generateId();
  if (input.id !== undefined) {
    requireUrlSafeId(input.id, '/id');
  }

  const { invoker } = await authorizedByProposedController(ctx, urls.spacesUrl(), controller);

  // Security-critical: refuse an existing id before writing anything (see the file header).
  if (await ctx.tx.getSpace(id)) {
    throw new PwsError('id-conflict', 'A Space with this id already exists.');
  }

  const space = await insertSpace(ctx, { id, input, controller, createdBy: invoker });

  return ctx.json(201, spaceView(urls, space), {
    location: urls.spaceUrl(space.id),
    ...etagHeader(space.validator),
  });
}

async function insertSpace(
  ctx: OpContext,
  args: { id: string; input: ReturnType<typeof readSpaceBody>; controller: string; createdBy: string },
): Promise<SpaceRecord> {
  const now = ctx.now.toISOString();
  const space: SpaceRecord = {
    id: args.id,
    type: args.input.type,
    ...(args.input.name !== undefined ? { name: args.input.name } : {}),
    controller: args.controller,
    createdBy: args.createdBy,
    createdAt: now,
    stamp: ctx.stamp(),
    validator: newValidator(),
  };
  await ctx.tx.putSpace(space);

  return space;
}

// --- a Space ---------------------------------------------------------------------------------

/** `GET /space/{s}/meta`. */
export async function readSpace(ctx: OpContext, spaceId: string): Promise<PwsResponse> {
  const space = await requireSpace(ctx, spaceId);
  await ctx.authorize({
    spaceUrl: ctx.env.urls.spaceUrl(spaceId),
    rootController: space.controller,
    policyChain: policyChain(spaceId),
  });
  const etag = etagOf(space.validator);
  if (ctx.precondition(etag) === 'not-modified') {
    return emptyResponse(304, { etag });
  }

  return ctx.json(200, spaceView(ctx.env.urls, space), { etag });
}

/** `PUT /space/{s}/meta`: replace the Metadata object, or create the Space at this id. */
export async function putSpace(ctx: OpContext, spaceId: string): Promise<PwsResponse> {
  const { urls } = ctx.env;
  const spaceUrl = urls.spaceUrl(spaceId);
  const existing = await ctx.tx.getSpace(spaceId);

  if (!existing) {
    // Anonymous callers learn nothing: creating needs a signature, and its absence is a 404.
    if (ctx.authn.kind !== 'signed') {
      throw notFound();
    }

    const input = readSpaceBody(ctx.jsonObjectBody());
    if (input.id !== undefined && input.id !== spaceId) {
      throw invalidBody('"id" must match the Space in the URL.', '/id');
    }

    if (input.controller === undefined) {
      throw invalidBody('A "controller" DID is required to create a Space.', '/controller');
    }

    await requireControllerAcceptable(ctx.env.keys, input.controller);
    const { invoker } = await authorizedByProposedController(ctx, spaceUrl, input.controller);
    ctx.precondition(undefined);
    const space = await insertSpace(ctx, {
      id: spaceId,
      input,
      controller: input.controller,
      createdBy: invoker,
    });

    return ctx.json(201, spaceView(ctx.env.urls, space), {
      location: spaceUrl,
      ...etagHeader(space.validator),
    });
  }

  // Updating is controller-only and never delegable (the container rule).
  await ctx.authorize({
    spaceUrl,
    rootController: existing.controller,
    rule: { kind: 'root' },
    policyChain: policyChain(spaceId),
  });
  const input = readSpaceBody(ctx.jsonObjectBody());
  if (input.id !== undefined && input.id !== spaceId) {
    throw invalidBody('"id" must match the Space in the URL.', '/id');
  }

  let controller = existing.controller;
  if (input.controller !== undefined && input.controller !== existing.controller) {
    await requireControllerAcceptable(ctx.env.keys, input.controller);
    controller = input.controller;
  }

  ctx.precondition(etagOf(existing.validator));

  const updated: SpaceRecord = {
    ...existing,
    // A full replacement: an omitted `name` is cleared. `type` is accepted at creation only.
    ...(input.name !== undefined ? { name: input.name } : {}),
    controller,
    stamp: ctx.stamp(existing.stamp),
    validator: bump(existing.validator),
  };
  if (input.name === undefined) {
    delete updated.name;
  }

  await ctx.tx.putSpace(updated);

  return emptyResponse(204, etagHeader(updated.validator));
}

/** `DELETE /space/{s}/`. */
export async function deleteSpace(ctx: OpContext, spaceId: string): Promise<PwsResponse> {
  const spaceUrl = ctx.env.urls.spaceUrl(spaceId);
  // An absent Space has no controller to authorize against, so it answers like an unauthorized
  // request: 404. (The specification's idempotent 204 needs an owner to have been proven.)
  const space = await requireSpace(ctx, spaceId);
  await ctx.authorize({
    spaceUrl,
    rootController: space.controller,
    rule: { kind: 'root-or', delegated: deleteSpaceException(spaceUrl) },
    policyChain: policyChain(spaceId),
  });
  ctx.precondition(etagOf(space.validator));
  await ctx.tx.deleteSpace(spaceId);

  return emptyResponse(204);
}

/** `GET /space/{s}/`: the Space's Collections. */
export async function listCollections(ctx: OpContext, spaceId: string): Promise<PwsResponse> {
  const { urls } = ctx.env;
  const space = await requireSpace(ctx, spaceId);
  await ctx.authorize({
    spaceUrl: urls.spaceUrl(spaceId),
    rootController: space.controller,
    policyChain: policyChain(spaceId),
  });

  const scope = urls.spacePath(spaceId);
  const page = readPageRequest(ctx.url.searchParams, scope, ctx.env.page);
  const listed = await ctx.tx.listCollections(spaceId, {
    limit: page.limit,
    ...(page.after !== undefined ? { after: page.after } : {}),
  });
  const items: JsonObject[] = [];
  for (const collection of listed.items) {
    const policy = await ctx.tx.getPolicy({ spaceId, collectionId: collection.id });
    items.push(collectionListItem(urls, collection, policy?.type === 'PublicCanRead'));
  }

  const last = listed.items[listed.items.length - 1];

  return ctx.json(200, {
    url: scope,
    totalItems: await ctx.tx.countCollections(spaceId),
    items,
    ...(listed.hasMore && last ? { next: nextLink(scope, page.limit, last.id) } : {}),
  });
}

export { collectionMetaException };
