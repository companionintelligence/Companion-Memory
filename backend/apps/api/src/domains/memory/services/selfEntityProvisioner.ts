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
