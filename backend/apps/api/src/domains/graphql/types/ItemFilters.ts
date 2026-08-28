import { registerEnumType } from '@nestjs/graphql';

import type { ObjectLifecycleState } from '@ci/domains/memory';

/**
 * Ownership state of a physical thing.
 *
 * `satisfies Record<Uppercase<T>, T>` for the same reason the physical-property
 * enums are: the `objects_lifecycle_state_check` constraint, the domain union
 * and this enum widen together or not at all.
 */
export const ItemLifecycleState = {
  ACTIVE: 'active',
  STORED: 'stored',
  LENT_OUT: 'lent_out',
  LOST: 'lost',
  DISPOSED: 'disposed',
  CONSUMED: 'consumed',
  RETURNED: 'returned',
  ARCHIVED: 'archived',
} as const satisfies Record<Uppercase<ObjectLifecycleState>, ObjectLifecycleState>;

export type ItemLifecycleState = (typeof ItemLifecycleState)[keyof typeof ItemLifecycleState];

registerEnumType(ItemLifecycleState, {
  name: 'ItemLifecycleState',
  description: 'Ownership state. A disposed thing is still a thing that happened, so it is never deleted.',
});

/**
 * Sort orders the things list offers.
 *
 * `NEWEST` is the only one the live keyset index (`user_id, created_at DESC,
 * object_id DESC`) serves directly, and it is therefore the only one paged
 * purely in SQL. Every other order is a REFINEMENT: the resolver walks the same
 * keyset, bounded, and orders the window it drew. See the note on
 * `ItemResolver.items`.
 */
export enum ItemSortOrder {
  NEWEST = 'NEWEST',
  OLDEST = 'OLDEST',
  NAME_ASC = 'NAME_ASC',
  NAME_DESC = 'NAME_DESC',
  VALUE_DESC = 'VALUE_DESC',
  VALUE_ASC = 'VALUE_ASC',
  RECENTLY_ACQUIRED = 'RECENTLY_ACQUIRED',
  RECENTLY_SEEN = 'RECENTLY_SEEN',
}

registerEnumType(ItemSortOrder, {
  name: 'ItemSortOrder',
  description:
    'How to order the things list. NEWEST is served by the keyset index; the others order a bounded window of it.',
});
