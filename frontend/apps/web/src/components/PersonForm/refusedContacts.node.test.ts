import { describe, expect, it } from 'vitest';

import { emptyPersonDraft, type PersonDraft } from './personDraft';
import {
  type RefusedContact,
  keepContactInNote,
  pendingRefusals,
  refusalFor,
  refusedContactsFrom,
} from './refusedContacts';

const REFUSED: RefusedContact = {
  kind: 'phone',
  value: '212-555-0148 x31',
  label: 'work',
  reason: 'extension',
};

/** The shape Apollo Client rejects a mutation with when the server answers with errors. */
function apolloError(extensions: Record<string, unknown>) {
  return Object.assign(new Error('refused'), {
    graphQLErrors: [{ message: 'refused', extensions }],
  });
}

function draftWith(overrides: Partial<PersonDraft>): PersonDraft {
  return { ...emptyPersonDraft(), ...overrides };
}

describe('refusedContactsFrom', () => {
  it('reads the refused contacts the server attaches to the error', () => {
    const error = apolloError({ code: 'BAD_USER_INPUT', details: { refusedContacts: [REFUSED] } });

    expect(refusedContactsFrom(error)).toEqual([REFUSED]);
  });

  it('is empty for any other failure', () => {
    expect(refusedContactsFrom(new Error('network down'))).toEqual([]);
    expect(refusedContactsFrom(apolloError({ code: 'CONFLICT' }))).toEqual([]);
    expect(refusedContactsFrom(null)).toEqual([]);
  });

  it('keeps "no label" apart from "label not reported"', () => {
    const { label: _label, ...unlabelled } = REFUSED;
    const error = apolloError({ details: { refusedContacts: [{ ...REFUSED, label: null }, unlabelled] } });

    expect(refusedContactsFrom(error)).toEqual([{ ...REFUSED, label: null }, unlabelled]);
  });

  it('drops entries it does not understand rather than pointing at the wrong row', () => {
    const error = apolloError({
      details: {
        refusedContacts: [REFUSED, { kind: 'fax', value: '2125550148', reason: 'extension' }, 'nonsense'],
      },
    });

    expect(refusedContactsFrom(error)).toEqual([REFUSED]);
  });
});

describe('refusalFor / pendingRefusals', () => {
  const row = { key: 'contact-1', kind: 'phone' as const, value: ' 212-555-0148 x31 ', label: 'work' };

  it('matches the row by the value it sent, which is the trimmed one', () => {
    expect(refusalFor(row, [REFUSED])).toEqual(REFUSED);
  });

  it('lets an edit of the row retire its refusal', () => {
    expect(refusalFor({ ...row, value: '212-555-0148' }, [REFUSED])).toBeUndefined();
  });

  it('lets a change of label retire it too: putting a relabelled number back is the fix', () => {
    expect(refusalFor({ ...row, label: 'mobile' }, [REFUSED])).toBeUndefined();
    expect(refusalFor({ ...row, label: '' }, [{ ...REFUSED, label: null }])).toEqual({
      ...REFUSED,
      label: null,
    });
  });

  it('matches any label when an older API did not say which', () => {
    const { label: _label, ...unlabelled } = REFUSED;

    expect(refusalFor({ ...row, label: 'mobile' }, [unlabelled])).toEqual(unlabelled);
  });

  it('lists only the refusals a row still holds', () => {
    expect(pendingRefusals(draftWith({ contacts: [row] }), [REFUSED])).toEqual([REFUSED]);
    expect(pendingRefusals(draftWith({ contacts: [] }), [REFUSED])).toEqual([]);
  });
});

describe('keepContactInNote', () => {
  const extension = { key: 'contact-1', kind: 'phone' as const, value: '212-555-0148 x31', label: 'work' };
  const other = { key: 'contact-2', kind: 'phone' as const, value: '212 555 0149', label: '' };

  it('moves the row into the notes, keeping its label', () => {
    const next = keepContactInNote(draftWith({ contacts: [extension, other] }), 'contact-1');

    expect(next.contacts).toEqual([other]);
    expect(next.description).toBe('Work phone: 212-555-0148 x31');
  });

  it('adds to what the notes already say, on a line of its own', () => {
    const next = keepContactInNote(
      draftWith({ contacts: [{ ...extension, label: '' }], description: 'Met at the conference.\n' }),
      'contact-1',
    );

    expect(next.description).toBe('Met at the conference.\nPhone: 212-555-0148 x31');
  });

  it('does not write the same line twice', () => {
    const next = keepContactInNote(
      draftWith({ contacts: [extension], description: 'Work phone: 212-555-0148 x31' }),
      'contact-1',
    );

    expect(next.description).toBe('Work phone: 212-555-0148 x31');
    expect(next.contacts).toEqual([]);
  });

  it('leaves the draft alone for a row that is not there', () => {
    const draft = draftWith({ contacts: [other] });

    expect(keepContactInNote(draft, 'contact-9')).toBe(draft);
  });
});
