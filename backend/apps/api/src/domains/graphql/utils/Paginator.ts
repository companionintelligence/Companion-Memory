import type { PageInfo } from '../types/PageInfo';

interface Args<T> {
  getId: (item: T) => string;
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

interface Result<T> {
  slice: T[];
  pageInfo: PageInfo;
  totalCount: number;
}

export class Paginator {
  static paginate<T>(items: T[], args: Args<T>): Result<T> {
    const { getId, first, after, last, before } = args;

    // Validate mutually exclusive pagination arguments
    const isForward = first != null || after != null;
    const isBackward = last != null || before != null;

    if (isForward && isBackward) {
      throw new Error('Cannot use forward pagination (first/after) with backward pagination (last/before)');
    }

    let startIndex = 0;
    let endIndex = items.length;

    if (isBackward) {
      if (before) {
        const beforeIdx = items.findIndex((item) => getId(item) === before);
        if (beforeIdx >= 0) {
          endIndex = beforeIdx;
        }
      }

      if (last != null) {
        startIndex = Math.max(endIndex - last, 0);
      }
    } else {
      if (after) {
        const afterIdx = items.findIndex((item) => getId(item) === after);
        if (afterIdx >= 0) {
          startIndex = afterIdx + 1;
        }
      }

      if (first != null) {
        endIndex = Math.min(startIndex + first, items.length);
      }
    }

    const slice = items.slice(startIndex, endIndex);

    return {
      slice,
      pageInfo: {
        hasNextPage: endIndex < items.length,
        hasPreviousPage: startIndex > 0,
        startCursor: slice.length > 0 ? getId(slice[0]) : null,
        endCursor: slice.length > 0 ? getId(slice[slice.length - 1]) : null,
      },
      totalCount: items.length,
    };
  }
}
