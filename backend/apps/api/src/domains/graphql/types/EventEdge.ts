import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { EventType } from './EventType';

@ObjectType({ implements: () => [Edge] })
export class EventEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => EventType)
  node!: EventType;
}
