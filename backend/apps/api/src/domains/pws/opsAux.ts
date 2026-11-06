/**
 * Auxiliary resources: the access control policy of a Space, Collection or Resource, the linksets
 * that advertise it, the endpoints of optional groups this server does not implement, and the
 * service description.
 *
 * Policies are administered by the controller or whoever the controller delegated to, and a
 * policy never grants access to a policy: reading or writing one always needs a capability, so a
 * `PublicCanRead` target does not expose how it is governed.
 */
import { isRecognizedPolicy, POLICY_TYPES } from './access';
import type { NormalizedRequest } from './authn';
import { evaluatePreconditions } from './conditional';
import { policyChain } from './context';
import type { HandlerEnv, OpContext } from './context';
import { emptyResponse, jsonResponse } from './http';
import type { PwsResponse } from './http';
import { PwsError, invalidBody, notFound } from './problems';
import { requireCollection } from './opsCollection';
import { requireSpace } from './opsSpace';
import { buildServiceDescription } from './serviceDescription';
import { linkset } from './views';
import type { PolicyScope } from './models';
import { createHash } from 'node:crypto';

// --- policy ----------------------------------------------------------------------------------

/** `GET` / `PUT` / `DELETE` of `.../policy` at `scope` (a Space, a Collection, or a Resource). */
export async function policyEndpoint(ctx: OpContext, scope: PolicyScope): Promise<PwsResponse> {
  const { spaceId, collectionId, resourceId } = scope;
  const space = await requireSpace(ctx, spaceId);
  // No policy chain: a policy is never what authorizes access to a policy.
  await ctx.authorize({ spaceUrl: ctx.env.urls.spaceUrl(spaceId), rootController: space.controller });
  if (collectionId !== undefined) {
    await requireCollection(ctx, spaceId, collectionId);
  }
  if (
    resourceId !== undefined &&
    collectionId !== undefined &&
    !(await ctx.tx.getResource(spaceId, collectionId, resourceId))
  ) {
    throw notFound();
  }

  switch (ctx.method) {
    case 'GET':
    case 'HEAD': {
      const policy = await ctx.tx.getPolicy(scope);
      if (!policy) {
        throw notFound();
      }
      return ctx.json(200, policy);
    }
    case 'PUT': {
      const body = ctx.jsonObjectBody() as { type?: unknown };
      if (typeof body.type !== 'string' || body.type.length === 0) {
        throw invalidBody('A policy needs a string "type".', '/type');
      }
      if (!isRecognizedPolicy(body as { type: string })) {
        throw invalidBody(
          `The policy type "${body.type}" is not one this server evaluates (${POLICY_TYPES.join(', ')}).`,
          '/type',
        );
      }
      const existed = (await ctx.tx.getPolicy(scope)) !== undefined;
      await ctx.tx.putPolicy(scope, { type: body.type });
      return emptyResponse(existed ? 204 : 201);
    }
    default:
      await ctx.tx.deletePolicy(scope);
      return emptyResponse(204);
  }
}

// --- linksets --------------------------------------------------------------------------------

/** `GET /space/{s}/linkset` and `GET /space/{s}/{c}/linkset`. */
export async function linksetEndpoint(
  ctx: OpContext,
  spaceId: string,
  collectionId?: string,
): Promise<PwsResponse> {
  const { urls } = ctx.env;
  const space = await requireSpace(ctx, spaceId);
  await ctx.authorize({
    spaceUrl: urls.spaceUrl(spaceId),
    rootController: space.controller,
    policyChain: policyChain(spaceId, collectionId),
  });
  if (collectionId !== undefined) {
    await requireCollection(ctx, spaceId, collectionId);
  }
  const anchor =
    collectionId === undefined ? urls.spacePath(spaceId) : urls.collectionPath(spaceId, collectionId);
  const policyPath =
    collectionId === undefined
      ? urls.path(`space/${spaceId}/policy`)
      : urls.path(`space/${spaceId}/${collectionId}/policy`);
  return jsonResponse(200, linkset(urls, anchor, policyPath), {}, 'application/linkset+json');
}

// --- optional groups this server does not implement --------------------------------------------

/**
 * Backends, quotas, queries, export/import, the governing history log and chunked Resources are
 * optional groups. Their path segments stay reserved, and a caller who is authorized for the
 * container is told plainly that the group is absent (`unsupported-operation`, 501); anyone else
 * gets the `not-found` of any other unauthorized request.
 *
 * The Collection query endpoint is the one place the specification fixes a request shape that holds
 * whether or not a profile is served: the body is an object with a REQUIRED `profile` string, and the
 * check comes after authorization (Query Profile Registry). A body that has one names a profile this
 * server does not serve, and is the 501.
 */
export async function unimplementedGroup(
  ctx: OpContext,
  spaceId: string,
  collectionId?: string,
  options: { queryProfile?: boolean } = {},
): Promise<PwsResponse> {
  const space = await requireSpace(ctx, spaceId);
  await ctx.authorize({ spaceUrl: ctx.env.urls.spaceUrl(spaceId), rootController: space.controller });
  if (collectionId !== undefined) {
    await requireCollection(ctx, spaceId, collectionId);
  }
  if (options.queryProfile) {
    const { profile } = ctx.jsonObjectBody();
    if (typeof profile !== 'string' || profile === '') {
      throw invalidBody('A query body needs a "profile" string.', '/profile');
    }
  }
  throw new PwsError(
    'unsupported-operation',
    'This server does not implement that optional group of operations.',
  );
}

// --- service description ----------------------------------------------------------------------

export function serviceDescriptionResponse(env: HandlerEnv, req: NormalizedRequest): PwsResponse {
  const bytes = new TextEncoder().encode(
    JSON.stringify(buildServiceDescription(env.urls, env.instance, env.clock.originId)),
  );
  const etag = `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 22)}"`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'public, max-age=3600',
    etag,
    'access-control-allow-origin': '*',
  };
  const precondition = evaluatePreconditions({
    method: req.method,
    ifMatch: undefined,
    ifNoneMatch: req.headers['if-none-match'],
    currentEtag: etag,
  });
  if (precondition === 'not-modified') {
    return emptyResponse(304, headers);
  }
  return { status: 200, headers: { ...headers, 'content-length': String(bytes.byteLength) }, body: bytes };
}
