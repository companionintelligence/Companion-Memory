import { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { emptyPersonDraft, type PersonDraft } from './personDraft';
import { PersonForm } from './PersonForm';

/** The form is controlled; this holds its state the way the modals do. */
function Harness({ initial = emptyPersonDraft() }: { initial?: PersonDraft }) {
  const [draft, setDraft] = useState(initial);

  return <PersonForm value={draft} onChange={setDraft} />;
}

describe('PersonForm', () => {
  it('starts with no contact or address rows', () => {
    render(<Harness />);

    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Street')).not.toBeInTheDocument();
  });

  it('adds a labelled email row, then a second one', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /Add email/ }));
    expect(screen.getAllByLabelText('Email address')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Add email/ }));
    expect(screen.getAllByLabelText('Email address')).toHaveLength(2);
  });

  it('removes the row that was clicked, not the last one', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /Add email/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add email/ }));

    const [first, second] = screen.getAllByLabelText('Email address');
    fireEvent.change(first!, { target: { value: 'first@example.com' } });
    fireEvent.change(second!, { target: { value: 'second@example.com' } });

    // Remove the FIRST row: a key-by-index implementation would drop the wrong
    // value here and leave 'first@example.com' behind.
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove email' })[0]!);

    const remaining = screen.getAllByLabelText('Email address');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveValue('second@example.com');
  });

  it('pre-labels the address a user adds with the button they pressed', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /Add work/ }));

    expect(screen.getByLabelText('Label (primary address)')).toHaveValue('work');
  });

  it('marks only the first address as primary in its label', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /Add home/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add work/ }));

    expect(screen.getByLabelText('Label (primary address)')).toHaveValue('home');
    expect(screen.getByLabelText('Label')).toHaveValue('work');
  });

  it('surfaces the name error against the name field', () => {
    const draft = emptyPersonDraft();

    render(<PersonForm value={draft} onChange={() => {}} nameError="Enter a name" />);

    expect(screen.getByText('Enter a name')).toBeInTheDocument();
  });

  it('disables every field while saving', () => {
    render(<PersonForm value={emptyPersonDraft()} onChange={() => {}} disabled />);

    expect(screen.getByLabelText(/Display name/)).toBeDisabled();
  });

  // The modals open *because* the user is about to type, so they keep the
  // focus grab. A page that merely contains this form does not want it: on a
  // phone it scrolls past the heading into the middle of the form and opens
  // the keyboard over it.
  it('focuses First name on mount for the modal call sites', () => {
    render(<Harness />);

    expect(screen.getByLabelText('First name')).toHaveFocus();
  });

  it('leaves focus alone when the caller opts out', () => {
    render(<PersonForm value={emptyPersonDraft()} onChange={() => {}} autoFocusName={false} />);

    expect(screen.getByLabelText('First name')).not.toHaveFocus();
  });

  // The contact row's fixed columns (type 6rem + label 7rem + remove 2.25rem
  // + gaps) came to ~17rem, which left the value field — the only one that
  // matters — about three characters wide on a phone. It has to be able to
  // take the full row instead.
  it('lets a contact row wrap so the value field is full width on a phone', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /Add email/ }));

    const row = screen.getByLabelText('Email address').closest('div')?.parentElement;
    expect(row?.className).toContain('w-full');
    expect(row?.className).toContain('sm:flex-1');
  });
});
