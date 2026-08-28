import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { ReceiptEdge } from './ReceiptEdge';

@ObjectType({ implements: () => [Connection] })
export class ReceiptConnection implements Connection {
  @Field(() => [ReceiptEdge])
  edges!: ReceiptEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  /**
   * Receipts matching the filter, as far as the keyset walk knows.
   *
   * `ReceiptService.find` is a pure keyset read with no COUNT — deliberately, so
   * cost stays bounded by page size — so this is the number of rows returned so
   * far, not a library-wide total. `pageInfo.hasNextPage` is the honest answer
   * to "is there more".
   */
  @Field(() => Int)
  totalCount!: number;
}
