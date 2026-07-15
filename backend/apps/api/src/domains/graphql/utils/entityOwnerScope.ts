import { type RequestContext, type UserServiceContext, toServiceContext } from '@ci/common/context';

/**
 * Scope an entity node's lazily-resolved sub-fields (media, relations, tags) to
 * the entity's OWNER rather than the request's viewer.
 *
 * On a normal query the entity is already viewer-scoped, so its `userId` equals
 * the viewer's and this is a no-op. On the shared-search path (SearchResolver
 * .runSharedSearch) a result node belongs to the saved-search owner, not the
 * viewer — without this its thumbnails, location, people and tags would resolve
 * under the viewer's scope and come back empty (e.g. a shared photo gallery
 * would render blank). The node id is itself the authorization boundary: a
 * viewer only ever obtains nodes a resolver chose to hand them (the shared path
 * is the sole cross-user read), so resolving a node's sub-fields as that node's
 * owner widens nothing.
 *
 * Falls back to the viewer context when the node carries no `userId`.
 */
export function entityOwnerScope(
  context: RequestContext,
  ownerId: string | null | undefined,
): UserServiceContext {
  return ownerId ? { userId: ownerId } : toServiceContext(context);
}
