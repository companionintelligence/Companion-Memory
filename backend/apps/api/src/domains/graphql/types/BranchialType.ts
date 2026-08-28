import { Field, Float, ObjectType } from '@nestjs/graphql';

import type {
  BranchialBranch,
  BranchialPermutation,
  BranchialStep,
  BranchialTree,
} from '@ci/domains/agent';

@ObjectType({ description: 'Who or what under a named future (slider 2, laid out in time)' })
export class BranchialPermutationType {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  title!: string;

  @Field(() => Float)
  mass!: number;

  static toType(source: BranchialPermutation): BranchialPermutationType {
    return { id: source.id, title: source.title, mass: source.mass };
  }
}

@ObjectType({ description: 'One competing future at a clock step' })
export class BranchialBranchType {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  title!: string;

  @Field(() => String, { description: 'Parent L0 class (WORK, LEISURE, ...)' })
  l0!: string;

  @Field(() => Float)
  mass!: number;

  @Field(() => String)
  why!: string;

  @Field(() => [BranchialPermutationType!]!)
  permutations!: BranchialPermutationType[];

  static toType(source: BranchialBranch): BranchialBranchType {
    return {
      id: source.id,
      title: source.title,
      l0: source.l0,
      mass: source.mass,
      why: source.why,
      permutations: source.permutations.map(BranchialPermutationType.toType),
    };
  }
}

@ObjectType({ description: 'A remaining daypart or week-ahead day' })
export class BranchialStepType {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  label!: string;

  @Field(() => String)
  startTime!: string;

  @Field(() => [BranchialBranchType!]!)
  branches!: BranchialBranchType[];

  static toType(source: BranchialStep): BranchialStepType {
    return {
      id: source.id,
      label: source.label,
      startTime: source.startTime,
      branches: source.branches.map(BranchialBranchType.toType),
    };
  }
}

@ObjectType({
  description:
    'Branchial-time tree: occupancy spine from the histogram/week forecast, optionally named by an LLM guess from memory',
})
export class BranchialTreeType {
  @Field(() => String)
  question!: string;

  @Field(() => Boolean, { description: 'True when branch titles came from the memory guess, not raw L0 labels' })
  guessed!: boolean;

  @Field(() => [BranchialStepType!]!)
  steps!: BranchialStepType[];

  static toType(source: BranchialTree): BranchialTreeType {
    return {
      question: source.question,
      guessed: source.guessed,
      steps: source.steps.map(BranchialStepType.toType),
    };
  }
}
