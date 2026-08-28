import { gql, useMutation, useQuery } from '@apollo/client';

const FORAGE_FIELDS = `
  question
  horizon
  kind
  pin
  resolved
  ready
  pick
  texture
  textureMass
  permutationBranch
  branches { id mass ready past pinned topTexture }
  permutations { label mass }
  interests { person activities }
  attention { gaze id label source read g epistemic risk ambiguity }
  reads { itemId cue g epistemic branchDelta { label mass } }
`;

export const GET_FORAGE = gql`
  query GetForage {
    forage {
      ${FORAGE_FIELDS}
    }
  }
`;

export const FORAGE_SAMPLE = gql`
  mutation ForageSample {
    forageSample {
      ${FORAGE_FIELDS}
    }
  }
`;

export const FORAGE_PIN = gql`
  mutation ForagePin($branch: String!) {
    foragePin(branch: $branch) {
      ${FORAGE_FIELDS}
    }
  }
`;

export const FORAGE_RESET = gql`
  mutation ForageReset {
    forageReset {
      ${FORAGE_FIELDS}
    }
  }
`;

export type ForageMass = { label: string; mass: number };
export type ForageBranch = {
  id: string;
  mass: number;
  ready: boolean;
  past: boolean;
  pinned: boolean;
  topTexture?: string | null;
};
export type ForageItem = {
  gaze: number;
  id: string;
  label: string;
  source?: string | null;
  read: boolean;
  g: number;
  epistemic: number;
  risk: number;
  ambiguity: number;
};
export type ForageRead = {
  itemId: string;
  cue: string;
  g: number;
  epistemic: number;
  branchDelta: ForageMass[];
};
export type ForageTrial = {
  question: string;
  horizon: string;
  kind?: string | null;
  pin?: string | null;
  resolved: boolean;
  ready: boolean;
  pick?: string | null;
  texture?: string | null;
  textureMass?: number | null;
  permutationBranch: string;
  branches: ForageBranch[];
  permutations: ForageMass[];
  interests: Array<{ person: string; activities: string[] }>;
  attention: ForageItem[];
  reads: ForageRead[];
};

export function useForage() {
  const { data, loading } = useQuery<{ forage: ForageTrial | null }>(GET_FORAGE, {
    errorPolicy: 'all',
  });
  const [sample, sampleState] = useMutation(FORAGE_SAMPLE, { refetchQueries: ['GetForage'] });
  const [pin, pinState] = useMutation(FORAGE_PIN, { refetchQueries: ['GetForage'] });
  const [reset, resetState] = useMutation(FORAGE_RESET, { refetchQueries: ['GetForage'] });

  return {
    trial: data?.forage ?? null,
    loading,
    busy: sampleState.loading || pinState.loading || resetState.loading,
    sample: () => sample(),
    pinBranch: (branch: string) => pin({ variables: { branch } }),
    resetTrial: () => reset(),
  };
}
