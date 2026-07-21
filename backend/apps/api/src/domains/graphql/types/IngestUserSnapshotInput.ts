import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class IngestUserSnapshotInput {
  @Field(() => ID)
  deviceId!: string;

  @Field(() => ID)
  sessionId!: string;

  @Field(() => String)
  snapshotKind!: string;

  @Field(() => Date)
  observedAt!: Date;

  @Field(() => Float)
  monotonicMs!: number;

  @Field(() => GraphQLJSONObject)
  payload!: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  focusApp?: string;

  @Field(() => String, { nullable: true })
  focusTitle?: string;

  @Field(() => String, { nullable: true })
  cwd?: string;

  @Field(() => Int)
  fsEventCount!: number;
}
