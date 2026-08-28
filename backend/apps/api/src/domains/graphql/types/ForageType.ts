import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

import type { ForageTrialResponse } from '@ci/domains/predictions';

@ObjectType({ description: 'A named probability mass (branch, person, or delta)' })
export class ForageMassType {
  @Field(() => String)
  label!: string;

  @Field(() => Float)
  mass!: number;
}

@ObjectType({ description: 'One Saturday hypothesis in the forage joint' })
export class ForageBranchType {
  @Field(() => String)
  id!: string;

  @Field(() => Float)
  mass!: number;

  @Field(() => Boolean)
  ready!: boolean;

  @Field(() => Boolean)
  past!: boolean;

  @Field(() => Boolean)
  pinned!: boolean;

  @Field(() => String, { nullable: true })
  topTexture!: string | null;
}

@ObjectType({ description: 'A lake item scored as a saccade (expected free energy G)' })
export class ForageItemType {
  @Field(() => Int)
  gaze!: number;

  @Field(() => String)
  id!: string;

  @Field(() => String)
  label!: string;

  @Field(() => String, { nullable: true, description: 'Index the fact came from: person, place, event, search, graph, derived' })
  source!: string | null;

  @Field(() => Boolean)
  read!: boolean;

  @Field(() => Float)
  g!: number;

  @Field(() => Float)
  epistemic!: number;

  @Field(() => Float)
  risk!: number;

  @Field(() => Float)
  ambiguity!: number;
}

@ObjectType({ description: 'One fact the eye already read' })
export class ForageReadType {
  @Field(() => String)
  itemId!: string;

  @Field(() => String)
  cue!: string;

  @Field(() => Float)
  g!: number;

  @Field(() => Float)
  epistemic!: number;

  @Field(() => [ForageMassType!]!)
  branchDelta!: ForageMassType[];
}

@ObjectType({ description: 'Activities that hang off (branch, who)' })
export class ForageInterestType {
  @Field(() => String)
  person!: string;

  @Field(() => [String!]!)
  activities!: string[];
}

@ObjectType({
  description:
    'CI Forager trial: discrete active inference over a memory lake. Not the occupancy histogram.',
})
export class ForageTrialType {
  @Field(() => String)
  question!: string;

  @Field(() => String)
  horizon!: string;

  @Field(() => String, { nullable: true, description: 'demo or memory' })
  kind!: string | null;

  @Field(() => String, { nullable: true })
  pin!: string | null;

  @Field(() => Boolean)
  resolved!: boolean;

  @Field(() => Boolean)
  ready!: boolean;

  @Field(() => String, { nullable: true })
  pick!: string | null;

  @Field(() => String, { nullable: true })
  texture!: string | null;

  @Field(() => Float, { nullable: true })
  textureMass!: number | null;

  @Field(() => String)
  permutationBranch!: string;

  @Field(() => [ForageBranchType!]!)
  branches!: ForageBranchType[];

  @Field(() => [ForageMassType!]!)
  permutations!: ForageMassType[];

  @Field(() => [ForageInterestType!]!)
  interests!: ForageInterestType[];

  @Field(() => [ForageItemType!]!)
  attention!: ForageItemType[];

  @Field(() => [ForageReadType!]!)
  reads!: ForageReadType[];

  static toType(source: ForageTrialResponse): ForageTrialType {
    return {
      question: source.question,
      horizon: source.horizon,
      kind: source.kind ?? null,
      pin: source.pin,
      resolved: source.resolved,
      ready: source.ready,
      pick: source.pick,
      texture: source.texture,
      textureMass: source.texture_mass,
      permutationBranch: source.permutation_branch,
      branches: source.branches.map((branch) => ({
        id: branch.id,
        mass: branch.mass,
        ready: branch.ready,
        past: branch.past,
        pinned: branch.pinned,
        topTexture: branch.top_texture,
      })),
      permutations: source.permutations,
      interests: Object.entries(source.interests).map(([person, activities]) => ({
        person,
        activities,
      })),
      attention: source.attention.map((item) => ({
        gaze: item.gaze,
        id: item.id,
        label: item.label,
        source: item.source ?? null,
        read: item.read,
        g: item.G,
        epistemic: item.epistemic,
        risk: item.risk,
        ambiguity: item.ambiguity,
      })),
      reads: source.reads.map((read) => ({
        itemId: read.item_id,
        cue: read.cue,
        g: read.G,
        epistemic: read.epistemic,
        branchDelta: Object.entries(read.branch_delta).map(([label, mass]) => ({ label, mass })),
      })),
    };
  }
}
