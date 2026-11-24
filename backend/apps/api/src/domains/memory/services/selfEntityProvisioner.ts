import type { ModuleRef } from '@nestjs/core';

import { type UserServiceContext } from '@ci/common/context';

/**
 * Provisions a user's self entity — the node `ci.users.entity_id` points at —
 * when it is absent, and returns it. GraphIngestService implements this and
 * GraphModule binds {@link SELF_ENTITY_PROVISIONER} to it.
 *
 * A token rather than the class, because GraphModule imports MemoryModule.
 * Injecting GraphIngestService into a memory service would need a module-level
 * cycle, and even a deep import of its file would close a CommonJS require
 * cycle through the memory barrel that file imports. So memory owns the
 * contract and graph supplies it; a memory service resolves it lazily with
 * `moduleRef.get(SELF_ENTITY_PROVISIONER, { strict: false })`, the pattern
 * ChatTurnService uses for RecallService.
 */
export const SELF_ENTITY_PROVISIONER = 'SELF_ENTITY_PROVISIONER';

export interface SelfEntityProvisioner {
  ensureSelfEntityForOwner(context: UserServiceContext): Promise<{ id: string; type: string } | null>;
}

/** The one question {@link ensureSelfEntityId} asks of `UserContextService`. */
export interface SelfIdentityLookup {
  getSelfIdentity(userId: string): Promise<{ entityId: string } | null>;
}

/**
 * The {@link SELF_ENTITY_PROVISIONER} binding, or `null` when there is none (a
 * container assembled without GraphModule, or a service built by hand with no
 * ModuleRef). Never throws: a caller that cannot provision falls back to the
 * error it always raised for a user with no self entity, which names the real
 * problem.
 */
export function resolveSelfEntityProvisioner(moduleRef: ModuleRef | undefined): SelfEntityProvisioner | null {
  try {
    return moduleRef?.get<SelfEntityProvisioner>(SELF_ENTITY_PROVISIONER, { strict: false }) ?? null;
  } catch {
    return null;
  }
}

/**
 * The id of the caller's own self entity, provisioning it first when the user
 * has none yet — for the WRITES that store something on it.
 *
 * `ci.users.entity_id` stays NULL until something self-anchored is ingested, and
 * nothing guarantees that ever happens: an account whose data came from an
 * import never gets one. Settings that live on the self person (the chat model,
 * Tools and Thinking, "Describe images", "Categorize browsing", the Autonomy
 * trust mode) then answered 500 `Self entity not found` on every save — and the
 * model picker, which reverts an optimistic selection when its write fails,
 * snapped back to the default each time. Provisioning is what graph ingest and
 * the Places page already do for the same gap.
 *
 * Three rules for whoever calls this:
 *
 *  - WRITES only. A read that finds no self entity keeps answering with its
 *    default (`getProfile` says `balanced`, `isEnabled` says off): creating a
 *    graph node because somebody GOT a setting is not what a read is for, and a
 *    page that polls would do it on its first visit.
 *  - The caller's own context, untouched. The provisioner makes the entity of
 *    `context.userId` and no other, and the leaf write that follows is scoped to
 *    the same owner (`PersonService.patchPropertyLeaves`). What may reach the
 *    route — its guard, its capability — is decided there and is not widened
 *    here: a caller who may write the setting may bootstrap the entity it is
 *    stored on, and nobody else can.
 *  - Still an error when nothing can provision one (no binding, no `ci.users`
 *    row to anchor): `Self entity not found`, as before.
 */
export async function ensureSelfEntityId(
  context: UserServiceContext,
  lookup: SelfIdentityLookup,
  moduleRef: ModuleRef | undefined,
): Promise<string> {
  const identity = await lookup.getSelfIdentity(context.userId);

  if (identity) {
    return identity.entityId;
  }

  const provisioned = await resolveSelfEntityProvisioner(moduleRef)?.ensureSelfEntityForOwner(context);

  if (!provisioned) {
    throw new Error('Self entity not found');
  }

  return provisioned.id;
}
