import { Field, Float, InputType, Int } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class IngestUserSnapshotInput {
  @Field(() => String)
  deviceId!: string;

  @Field(() => String)
  sessionId!: string;

  @Field(() => String)
  snapshotKind!: string;

  // RFC-3339 timestamp.
  @Field(() => String)
  observedAt!: string;

  // i64 milliseconds — Float keeps full precision beyond Int's 32-bit range.
  @Field(() => Float)
  monotonicMs!: number;

  @Field(() => GraphQLJSONObject)
  payload!: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  focusApp?: string | null;

  @Field(() => String, { nullable: true })
  focusTitle?: string | null;

  @Field(() => String, { nullable: true })
  cwd?: string | null;

  @Field(() => Int)
  fsEventCount!: number;
}
