import type { KeysetPageArgs } from '@ci/common/persistence';

import { GlobalUID } from '../types/GlobalUID';
import type { PageInfo } from '../types/PageInfo';
import type { PaginationArgs } from '../types/PaginationArgs';

/**
 * A connection's `first` / `after` / `last` / `before` as the page arguments a
 * service's `findPage` takes. The cursors are GlobalUID-encoded row ids — the
 * same cursors the in-memory `Paginator` handed out, so moving a list into SQL
 * changes nothing on the wire.
 */
export function keysetArgs(pagination: PaginationArgs): KeysetPageArgs {
  return {
    first: pagination.first,
    last: pagination.last,
    afterId: pagination.after ? GlobalUID.decode(pagination.after).id : null,
    beforeId: pagination.before ? GlobalUID.decode(pagination.before).id : null,
  };
}

/** The connection's `pageInfo`, from the page the service read and the edges built from it. */
export function keysetPageInfo(
  edges: ReadonlyArray<{ cursor: string }>,
  page: { hasNextPage: boolean; hasPreviousPage: boolean },
): PageInfo {
  return {
    hasNextPage: page.hasNextPage,
    hasPreviousPage: page.hasPreviousPage,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  };
}
