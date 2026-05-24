import { Field, ObjectType } from '@nestjs/graphql';

export interface PaginationArgs {
  first?: number;
  after?: string;
}

export interface PaginationResult<T> {
  slice: T[];
  pageInfo: PageInfo;
  totalCount: number;
}

@ObjectType()
export class PageInfo {
  @Field(() => Boolean)
  hasNextPage!: boolean;

  @Field(() => Boolean)
  hasPreviousPage!: boolean;

  @Field(() => String, { nullable: true })
  startCursor!: string | null;

  @Field(() => String, { nullable: true })
  endCursor!: string | null;

  static paginate<T>(items: T[], args: PaginationArgs, getId: (item: T) => string): PaginationResult<T> {
    const { first, after } = args;

    let startIndex = 0;

    if (after) {
      const idx = items.findIndex((item) => getId(item) === after);
      if (idx >= 0) {
        startIndex = idx + 1;
      }
    }

    const slice = first != null ? items.slice(startIndex, startIndex + first) : items.slice(startIndex);

    const endIndex = startIndex + slice.length;
    const cursors = slice.map(getId);

    const pageInfo: PageInfo = {
      hasNextPage: endIndex < items.length,
      hasPreviousPage: startIndex > 0,
      startCursor: cursors.length > 0 ? cursors[0] : null,
      endCursor: cursors.length > 0 ? cursors[cursors.length - 1] : null,
    };

    return {
      slice,
      pageInfo,
      totalCount: items.length,
    };
  }
}
