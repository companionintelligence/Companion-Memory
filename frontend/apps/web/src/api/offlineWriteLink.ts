/**
 * The GraphQL half of the write guard (`@ci/common`'s `offlineWrites.ts`): every GraphQL
 * operation is a POST, so the HTTP layer cannot tell a query from a mutation and leaves
 * `/api/graphql` alone. This link reads the operation and refuses mutations while the
 * connection probe says the appliance is unreachable — before anything leaves, and with
 * the same `OfflineWriteError` and shared dialog as a refused REST write.
 *
 * Note mutations pass. On a phone with a synced replica the note pages never issue them
 * (they write the local `notes` table and PowerSync replays), and in a browser a note is
 * the one thing a person may well be writing when the server drops; refusing it up front
 * would lose the text they typed where today's network failure leaves it on screen.
 */
import { ApolloLink, Observable, type FetchResult } from '@apollo/client';
import { getMainDefinition } from '@apollo/client/utilities';
import { assertApplianceWritable } from '@ci/common';
import type { DocumentNode } from 'graphql';

/** `CreateNote`, `UpdateNoteDetail`, `DeleteMemoryNote` — a "Note" word in the operation's name. */
export function isNoteOperationName(name: string | undefined): boolean {
  return /Notes?(?=[A-Z_]|$)/.test(name ?? '');
}

/** Whether `query` is a mutation the guard should consider: a mutation, and not about notes. */
export function isGuardedMutation(query: DocumentNode, operationName?: string): boolean {
  const definition = getMainDefinition(query);

  if (definition.kind !== 'OperationDefinition' || definition.operation !== 'mutation') {
    return false;
  }

  if (isNoteOperationName(operationName ?? definition.name?.value)) {
    return false;
  }

  // An anonymous mutation is judged by what it does: any root field on notes exempts it.
  const touchesNotes = definition.selectionSet.selections.some(
    (selection) => selection.kind === 'Field' && /note/i.test(selection.name.value),
  );

  return !touchesNotes;
}

export function createOfflineWriteLink(): ApolloLink {
  return new ApolloLink((operation, forward) => {
    if (isGuardedMutation(operation.query, operation.operationName)) {
      try {
        assertApplianceWritable({ operation: operation.operationName });
      } catch (err) {
        return new Observable<FetchResult>((observer) => {
          observer.error(err);
        });
      }
    }

    return forward(operation);
  });
}
