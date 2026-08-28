import { gql, useMutation, useQuery } from '@apollo/client';

const TREE_FIELDS = `
  question
  guessed
  steps {
    id
    label
    startTime
    branches {
      id
      title
      l0
      mass
      why
      permutations { id title mass }
    }
  }
`;

export const GET_BRANCHIAL = gql`
  query GetBranchial {
    branchialForecast {
      ${TREE_FIELDS}
    }
  }
`;

export const GUESS_BRANCHIAL = gql`
  mutation GuessBranchial {
    guessBranchialForecast {
      ${TREE_FIELDS}
    }
  }
`;

export type BranchialPermutation = {
  id: string;
  title: string;
  mass: number;
};

export type BranchialBranch = {
  id: string;
  title: string;
  l0: string;
  mass: number;
  why: string;
  permutations: BranchialPermutation[];
};

export type BranchialStep = {
  id: string;
  label: string;
  startTime: string;
  branches: BranchialBranch[];
};

export type BranchialTreeData = {
  question: string;
  guessed: boolean;
  steps: BranchialStep[];
};

export function useBranchial() {
  const { data, loading } = useQuery<{ branchialForecast: BranchialTreeData | null }>(GET_BRANCHIAL, {
    errorPolicy: 'all',
  });
  const [guess, guessState] = useMutation<{ guessBranchialForecast: BranchialTreeData | null }>(
    GUESS_BRANCHIAL,
    {
      update(cache, result) {
        const next = result.data?.guessBranchialForecast;
        if (!next) {
          return;
        }

        cache.writeQuery({
          query: GET_BRANCHIAL,
          data: { branchialForecast: next },
        });
      },
    },
  );

  return {
    tree: data?.branchialForecast ?? null,
    loading,
    guessing: guessState.loading,
    guess: () => guess(),
  };
}
