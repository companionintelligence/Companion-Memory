import { ApolloClient, ApolloProvider, InMemoryCache } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import type { Decorator, Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { MergeCandidateCard, type MergeCandidate } from './PeopleMergeCards';

// The card calls useMutation for merge/reject; those only fire on a click, so a
// client that is never reached is enough to render it.
const storyClient = new ApolloClient({
  uri: '/graphql',
  cache: new InMemoryCache(),
  connectToDevTools: false,
});

const withApollo: Decorator = (Story) => (
  <ApolloProvider client={storyClient}>
    <div className="max-w-2xl p-4">
      <Story />
    </div>
  </ApolloProvider>
);

// Every person and number is invented: the 555-01XX fiction range.
function phone(value: string, rawValue: string) {
  return {
    __typename: 'PersonIdentifierType',
    kind: 'phone',
    value,
    rawValue,
    label: null,
    source: 'import',
  };
}

function person(uuid: string, name: string, identifiers: unknown[]) {
  return {
    __typename: 'PersonType',
    id: GlobalUID.encode('person', uuid),
    name,
    description: null,
    avatarUrl: null,
    isSelf: false,
    identifiers,
    interactionStats: {
      __typename: 'PersonInteractionStatsType',
      eventCount: 0,
      communicationCount: 0,
      lastInteractionAt: null,
    },
  };
}

function candidate(
  people: unknown[],
  evidence: Array<[kind: string, value: string, score: number]>,
): MergeCandidate {
  return {
    __typename: 'MergeCandidateType',
    id: 'story-candidate',
    score: Math.max(...evidence.map(([, , score]) => score)),
    status: 'pending',
    detectedBy: 'clean.duplicate_detect',
    createdAt: '2026-09-29T00:00:00Z',
    evidence: evidence.map(([kind, value, score]) => ({
      __typename: 'MergeCandidateEvidenceType',
      kind,
      value,
      score,
    })),
    people,
  } as unknown as MergeCandidate;
}

const ADA = '019fd7c0-641c-76dd-8ed7-a5053faff601';
const BO = '019fd7c0-641c-76dd-8ed7-a5053faff602';

const meta: Meta<typeof MergeCandidateCard> = {
  title: 'People/Suggested merge card',
  component: MergeCandidateCard,
  decorators: [withApollo],
  args: { onMerged: fn(async () => undefined) },
};

export default meta;

type Story = StoryObj<typeof MergeCandidateCard>;

/**
 * The reported shape: a number both records carry, held back because the
 * names differ. Bo's contact list cannot show his copy (the identifier index
 * holds a number for one person only), so the card lists the evidence number
 * under him too — "shared" on both sides, never two unrelated "only here" lines.
 */
export const SharedNumberNamesDiffer: Story = {
  args: {
    candidate: candidate(
      [
        person(ADA, 'Ada Quill', [phone('2125550118', '(212) 555-0118')]),
        person(BO, 'Bo Brightwater', [phone('2125550110', '212-555-0110')]),
      ],
      [
        ['phone', '+12125550118', 0.85],
        ['phone_check', 'given_name_conflict', 0],
      ],
    ),
  },
};

/** A number whose country could not be confirmed for one side. */
export const SharedDigitsCountryUnconfirmed: Story = {
  args: {
    candidate: candidate(
      [person(ADA, 'Ada Quill', [phone('2025550142', '+1 (202) 555-0142')]), person(BO, 'Ada Q.', [])],
      [['phone', '2025550142', 0.75]],
    ),
  },
};
