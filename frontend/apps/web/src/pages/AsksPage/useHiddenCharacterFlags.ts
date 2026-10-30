import { useCallback, useEffect, useMemo, useRef } from 'react';

import { type ApolloError, useQuery, type OperationVariables, type TypedDocumentNode } from '@apollo/client';

/** One row of an `*_HIDDEN_CHARACTERS` answer. */
export interface HiddenCharacterRow {
  id: string;
  query: { promptHiddenCharactersRemoved: boolean };
}

/**
 * Where the hidden-characters check stands for one ask.
 *
 *  - `checked`: an answer covers this ask, or the Memory is too old to know the
 *    field, which means it never stripped anything to report.
 *  - `checking`: no answer covers it yet. The review card holds Approve until
 *    one does, so the owner can't approve before the note could appear.
 *  - `failed`: the check itself failed on a Memory that knows the field. The
 *    card says the message couldn't be checked and leaves the decision to the
 *    owner.
 */
export type HiddenCharacterCheck = 'checked' | 'checking' | 'failed';

export interface HiddenCharacterFlags {
  /** The ids whose prompt the server stripped of characters that render as nothing. */
  removed: ReadonlySet<string>;
  checkOf: (id: string) => HiddenCharacterCheck;
}

/**
 * Whether `error` is a Memory from before `promptHiddenCharactersRemoved`
 * refusing the field. Apollo Server answers that with a 400, which Apollo
 * Client reports as a network error carrying the response's `errors`; a 200
 * with `errors` lands in `graphQLErrors`. Both are read.
 */
export function refusesHiddenCharacterField(error: ApolloError | undefined): boolean {
  if (error == null) {
    return false;
  }

  const fromResponse = (error.networkError as { result?: { errors?: unknown } } | null)?.result?.errors;
  const errors: unknown[] = [...error.graphQLErrors, ...(Array.isArray(fromResponse) ? fromResponse : [])];

  return errors.some((entry) => {
    const message = (entry as { message?: unknown } | null)?.message;

    return typeof message === 'string' && message.includes('promptHiddenCharactersRemoved');
  });
}

/**
 * Which of `ids` had characters that render as nothing stripped from their
 * prompt (`AskQueryType.promptHiddenCharactersRemoved`), and whether the check
 * has answered for each.
 *
 * `document` is one of the `*_HIDDEN_CHARACTERS` queries in asksOperations.ts,
 * which ask for nothing else, so a Memory too old to know the field fails that
 * query alone and the inbox still loads. That one failure reads as "nothing
 * was removed", which is what an older server stored anyway. Any other failure
 * is reported as `failed` rather than swallowed: read as "nothing removed", it
 * let the owner approve a card whose warning never arrived.
 *
 * `no-cache`, because the answer is a partial `query` object for asks the cache
 * already holds whole. Written back, it would replace theirs and leave the list
 * it annotates without its prompts.
 *
 * Fetched again whenever `ids` changes under the same variables: the list's
 * own refetch does not reach this query, and a new ask is the one whose note
 * matters most. Until that answer arrives, the new ask reads `checking`.
 */
export function useHiddenCharacterFlags<TData, TVariables extends OperationVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  options: {
    ids: readonly string[];
    rowsOf: (data: TData) => readonly HiddenCharacterRow[] | null | undefined;
    variables?: TVariables;
  },
): HiddenCharacterFlags {
  const { ids, rowsOf, variables } = options;
  const key = ids.join(',');
  const { data, error, refetch } = useQuery(document, {
    ...(variables ? { variables } : {}),
    skip: key === '',
    errorPolicy: 'all',
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
      // A failure shows up as `error` on the hook; nothing to do with it here.
      refetch().catch(() => undefined);
    }

    askedFor.current = { key, variablesKey };
  }, [key, variablesKey, refetch]);

  const rows = useMemo(() => (data ? (rowsOf(data) ?? []) : []), [data, rowsOf]);
  const removed = useMemo(
    () => new Set(rows.filter((row) => row.query.promptHiddenCharactersRemoved).map((row) => row.id)),
    [rows],
  );
  const covered = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const olderMemory = refusesHiddenCharacterField(error);

  const checkOf = useCallback(
    (id: string): HiddenCharacterCheck => {
      if (covered.has(id) || olderMemory) {
        return 'checked';
      }

      return error ? 'failed' : 'checking';
    },
    [covered, olderMemory, error],
  );

  return useMemo(() => ({ removed, checkOf }), [removed, checkOf]);
}
