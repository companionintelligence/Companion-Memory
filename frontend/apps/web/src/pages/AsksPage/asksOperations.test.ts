import type { FieldNode, OperationDefinitionNode } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  ASK_ANSWER,
  ASK_DISCLOSURE_HISTORY,
  ASK_DISCLOSURE_SUMMARY,
  CREATE_ASK,
  CREATE_PEER_LINK,
  MY_ASK_GRANTS,
  MY_PEER_LINKS,
  RUN_ASK,
  UPDATE_ASK_GRANT,
} from './asksOperations';

/**
 * These assert on the DOCUMENTS, not on a rendered component.
 *
 * A field or argument that is missing from the operation is invisible from the
 * page: the control can exist, the handler can fire, the variable can be passed,
 * and the value still never leaves the browser. That is exactly how the
 * disclosure ladder shipped unreachable — the ladder was designed, the backend
 * clamped it, and the mutation document simply did not name the argument.
 */
function operation(document: unknown): OperationDefinitionNode {
  const definitions = (document as { definitions: OperationDefinitionNode[] }).definitions;

  return definitions[0];
}

function selectedFields(document: unknown, rootField = 0): string[] {
  const root = operation(document).selectionSet.selections[rootField] as FieldNode;

  return (root.selectionSet?.selections ?? []).map((selection) => (selection as FieldNode).name.value);
}

/** Fields selected inside one named sub-selection of the root field. */
function nestedFields(document: unknown, path: string): string[] {
  const root = operation(document).selectionSet.selections[0] as FieldNode;
  const child = (root.selectionSet?.selections ?? []).find(
    (selection) => (selection as FieldNode).name.value === path,
  ) as FieldNode | undefined;

  return (child?.selectionSet?.selections ?? []).map((selection) => (selection as FieldNode).name.value);
}

describe('RUN_ASK', () => {
  it('carries the owner’s disclosure form all the way onto the wire', () => {
    const op = operation(RUN_ASK);
    const field = op.selectionSet.selections[0] as FieldNode;

    // Both halves matter and they fail differently: without the variable
    // DEFINITION the document will not validate, and without the ARGUMENT the
    // value is accepted by the client and quietly dropped before the request.
    expect(op.variableDefinitions?.map((definition) => definition.variable.name.value)).toContain(
      'disclosureForm',
    );
    expect(field.arguments?.map((argument) => argument.name.value)).toContain('disclosureForm');
  });
});

describe('MY_ASK_GRANTS', () => {
  it('asks for the liveness field the matrix has to read', () => {
    // `revokedAt` is the only liveness fact on `AskGrantType` today. Dropping it
    // from the selection set is how a withdrawn grant renders as live consent.
    expect(selectedFields(MY_ASK_GRANTS)).toContain('revokedAt');
  });
});

describe('MY_ASK_GRANTS, continued', () => {
  it('reads liveness from the server rather than re-deriving it', () => {
    // `active` is the server's own `isGrantActive`. A second copy of that rule
    // on the client can disagree with the one that actually gates disclosure,
    // and the dangerous direction is a grant the page calls lapsed while the
    // server still honours it.
    expect(selectedFields(MY_ASK_GRANTS)).toEqual(expect.arrayContaining(['expiresAt', 'active']));
  });
});

describe('UPDATE_ASK_GRANT', () => {
  it('exists at all — the page spent its life saying this could not be done', () => {
    // The Grant Manager printed "Changing a grant's mode isn't available yet"
    // beside three disabled buttons while `updateAskGrant` sat on the schema,
    // resolved and unselected. Telling an owner a consent control does not
    // exist makes them plan around it.
    const op = operation(UPDATE_ASK_GRANT);

    expect(op.operation).toBe('mutation');
    expect(op.variableDefinitions?.map((definition) => definition.variable.name.value)).toEqual(
      expect.arrayContaining(['id', 'input']),
    );
  });
});

describe('ASK_DISCLOSURE_HISTORY', () => {
  it('selects the ONLY field that separates an auto-answer from a reviewed one', () => {
    // `AskAnswerType` carries no such flag, so `outcome` is the whole basis for
    // the history's auto-vs-reviewed distinction. Drop it and the surface that
    // makes a coerced grant survivable stops being able to show the thing worth
    // noticing.
    expect(nestedFields(ASK_DISCLOSURE_HISTORY, 'rows')).toEqual(
      expect.arrayContaining(['outcome', 'disclosedCount', 'askerId', 'createdAt']),
    );
  });

  it('selects `truncated`, so a capped read cannot render as a complete one', () => {
    expect(selectedFields(ASK_DISCLOSURE_HISTORY)).toEqual(expect.arrayContaining(['truncated', 'rows']));
  });

  it('accepts a filter, so the drill-in does not re-read every row', () => {
    expect(operation(ASK_DISCLOSURE_HISTORY).variableDefinitions?.map((d) => d.variable.name.value)).toEqual([
      'input',
    ]);
  });
});

describe('ASK_DISCLOSURE_SUMMARY', () => {
  it('keeps auto-answered and reviewed as SEPARATE counts on the wire', () => {
    // Summing them server-side would destroy the one distinction the surface
    // exists to make: whether a human was in the loop.
    expect(nestedFields(ASK_DISCLOSURE_SUMMARY, 'summaries')).toEqual(
      expect.arrayContaining(['autoAnswered', 'reviewed', 'declined', 'expired']),
    );
  });

  it('selects the magnitude, not only the ask count', () => {
    // "14 asks" and "213 items" are different facts, and only the second
    // describes what the other person now holds.
    expect(nestedFields(ASK_DISCLOSURE_SUMMARY, 'summaries')).toEqual(
      expect.arrayContaining(['itemsDisclosed', 'itemsInWindow', 'asksInWindow']),
    );
  });

  it('selects the grouping key the drill-in filters by', () => {
    expect(nestedFields(ASK_DISCLOSURE_SUMMARY, 'summaries')).toContain('key');
  });

  it('selects `truncated`, because the totals beside it are then floors', () => {
    expect(selectedFields(ASK_DISCLOSURE_SUMMARY)).toEqual(
      expect.arrayContaining(['truncated', 'summaries']),
    );
  });
});

describe('ASK_ANSWER', () => {
  it('reads the counts and the items the card has to tell apart', () => {
    expect(selectedFields(ASK_ANSWER)).toEqual(
      expect.arrayContaining(['summary', 'disclosedCount', 'withheldCount', 'items', 'form']),
    );
  });
});

describe('CREATE_ASK', () => {
  it('does NOT select `decision`, which would read as if it meant something', () => {
    // The resolver collapses it to a constant precisely so the asker cannot read
    // the responder's grant posture off it. Selecting a field whose only value
    // is a constant invites a future reader to render it.
    expect(selectedFields(CREATE_ASK)).not.toContain('decision');
  });
});

describe('peer link documents', () => {
  it('reads back the tier the SERVER chose rather than assuming the default held', () => {
    // The page deliberately sends no `trustTier` on create, so `stranger` is
    // the resolver's choice and not the client's — which means the client has
    // to read the result to know it. (That the call site omits the tier is
    // asserted where it can be: the AsksPage integration test.)
    const payload = (operation(CREATE_PEER_LINK).selectionSet.selections[0] as FieldNode).selectionSet
      ?.selections;
    const link = payload?.find(
      (selection) => (selection as FieldNode).name.value === 'peerLink',
    ) as FieldNode;

    expect((link.selectionSet?.selections ?? []).map((s) => (s as FieldNode).name.value)).toContain(
      'trustTier',
    );
  });

  it('selects the tier, the status and the revocation on the roster', () => {
    // The tier is the ceiling on everything a peer can be told; `status` and
    // `revokedAt` are what stop an ended link rendering as a live one. All
    // three, or the peer tab is decoration.
    expect(selectedFields(MY_PEER_LINKS)).toEqual(
      expect.arrayContaining(['trustTier', 'status', 'revokedAt']),
    );
  });

  it('selects avatarUrl on the roster, so a peer counterparty can show a real photo', () => {
    // Without this, `partyAvatar`'s join against `myPeerLinks` (askBinding.ts)
    // can resolve a display name but never a photo, and every peer-handled row
    // on the Asks page would silently fall back to initials even when the
    // linked Person has one set.
    expect(selectedFields(MY_PEER_LINKS)).toContain('avatarUrl');
  });
});
