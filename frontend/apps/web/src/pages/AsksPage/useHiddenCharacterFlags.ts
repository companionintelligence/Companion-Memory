import { useEffect, useMemo, useRef } from 'react';

import { useQuery, type OperationVariables, type TypedDocumentNode } from '@apollo/client';

/** One row of an `*_HIDDEN_CHARACTERS` answer. */
export interface HiddenCharacterRow {
  id: string;
  query: { promptHiddenCharactersRemoved: boolean };
}

/**
 * The ids, among `ids`, whose prompt the server stripped of characters that
 * render as nothing (`AskQueryType.promptHiddenCharactersRemoved`).
 *
 * `document` is one of the `*_HIDDEN_CHARACTERS` queries in asksOperations.ts,
 * which ask for nothing else, so a Memory too old to know the field fails that
 * query alone. `errorPolicy: 'ignore'` turns that failure into "nothing was
 * removed", which is what an older server stored anyway.
 *
 * `no-cache`, because the answer is a partial `query` object for asks the cache
 * already holds whole. Written back, it would replace theirs and leave the list
 * it annotates without its prompts.
 *
 * Fetched again whenever `ids` changes under the same variables: the list's
 * own refetch does not reach this query, and a new ask is the one whose note
 * matters most.
 */
export function useHiddenCharacterFlags<TData, TVariables extends OperationVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  options: {
    ids: readonly string[];
    rowsOf: (data: TData) => readonly HiddenCharacterRow[] | null | undefined;
    variables?: TVariables;
  },
): ReadonlySet<string> {
  const { ids, rowsOf, variables } = options;
  const key = ids.join(',');
  const { data, refetch } = useQuery(document, {
    ...(variables ? { variables } : {}),
    skip: key === '',
    errorPolicy: 'ignore',
    fetchPolicy: 'no-cache',
  });
  // New variables are a new query, which Apollo sends by itself.
  const variablesKey = JSON.stringify(variables ?? null);
  const askedFor = useRef<{ key: string; variablesKey: string } | null>(null);

  useEffect(() => {
    // Skipped while there is nothing to annotate. Going back to non-empty is a
    // fresh fetch Apollo sends itself, so it must not also count as a change.
    if (key === '') {
      askedFor.current = null;

      return;
    }

    const last = askedFor.current;

    if (last != null && last.variablesKey === variablesKey && last.key !== key) {
      void refetch();
    }

    askedFor.current = { key, variablesKey };
  }, [key, variablesKey, refetch]);

  return useMemo(() => {
    const rows = data ? (rowsOf(data) ?? []) : [];

    return new Set(rows.filter((row) => row.query.promptHiddenCharactersRemoved).map((row) => row.id));
  }, [data, rowsOf]);
}
