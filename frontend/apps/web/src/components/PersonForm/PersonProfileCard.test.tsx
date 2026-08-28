import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PersonDraftSource } from './personDraft';
import { PersonProfileCard } from './PersonProfileCard';

const PERSON: PersonDraftSource = {
  name: 'Dana Okafor',
  firstName: 'Dana',
  lastName: 'Okafor',
  nickname: 'Dee',
  pronouns: 'they/them',
  gender: 'Non-binary',
  birthDate: '1990-04-02',
  jobTitle: 'Staff Engineer',
  department: 'Platform',
  organization: 'Lifescope',
  website: 'https://dana.example.com',
  identifiers: [
    { kind: 'email', value: 'dana@example.com', label: 'home' },
    { kind: 'email', value: 'd.okafor@lifescope.example', label: 'work' },
    { kind: 'phone', value: '4155550100', rawValue: '+1 (415) 555-0100', label: 'mobile' },
  ],
  addresses: [
    { label: 'home', streetAddress: '1 Elm Street', city: 'Portland', region: 'OR', postalCode: '97201' },
    { label: 'work', streetAddress: '400 Market Street', streetAddress2: 'Floor 12', city: 'San Francisco' },
  ],
};

describe('PersonProfileCard', () => {
  it('renders every profile field, including both addresses', () => {
    render(<PersonProfileCard person={PERSON} />);

    expect(screen.getByText('Dee')).toBeInTheDocument();
    expect(screen.getByText('they/them')).toBeInTheDocument();
    expect(screen.getByText('Non-binary')).toBeInTheDocument();
    expect(screen.getByText('1990-04-02')).toBeInTheDocument();
    expect(screen.getByText('1 Elm Street, Portland, OR, 97201')).toBeInTheDocument();
    expect(screen.getByText('400 Market Street, Floor 12, San Francisco')).toBeInTheDocument();
    expect(screen.getByText('Staff Engineer · Platform · Lifescope')).toBeInTheDocument();
  });

  it('labels each address with the user-supplied label', () => {
    // No identifiers here: their labels render as badges with the same words,
    // so this keeps the assertion about the ADDRESS rows.
    render(<PersonProfileCard person={{ name: 'Dana', addresses: PERSON.addresses }} />);

    expect(screen.getByText('home')).toBeInTheDocument();
    expect(screen.getByText('work')).toBeInTheDocument();
  });

  it('falls back to "Address" when an address has no label', () => {
    render(<PersonProfileCard person={{ name: 'Dana', addresses: [{ city: 'Portland' }] }} />);

    expect(screen.getByText('Address')).toBeInTheDocument();
  });

  it('names the employment row "Job", not "Work"', () => {
    // An address labelled "work" sits in the same list; two WORK rows read as a
    // duplicate rather than two different facts.
    render(<PersonProfileCard person={PERSON} />);

    expect(screen.getByText('Job')).toBeInTheDocument();
  });

  it('renders contact methods as actionable links, showing the raw value', () => {
    render(<PersonProfileCard person={PERSON} />);

    expect(screen.getByRole('link', { name: 'dana@example.com' })).toHaveAttribute(
      'href',
      'mailto:dana@example.com',
    );
    // The phone shows as typed but dials the normalized number.
    expect(screen.getByRole('link', { name: '+1 (415) 555-0100' })).toHaveAttribute('href', 'tel:4155550100');
  });

  it('omits sections the person has nothing in', () => {
    render(<PersonProfileCard person={{ name: 'Nobody', nickname: 'Nick' }} />);

    expect(screen.getByText('Nick')).toBeInTheDocument();
    expect(screen.queryByText('Email')).not.toBeInTheDocument();
    expect(screen.queryByText('Job')).not.toBeInTheDocument();
  });

  it('drops addresses with no lines rather than rendering an empty row', () => {
    render(<PersonProfileCard person={{ name: 'Nobody', addresses: [{ label: 'home' }] }} />);

    expect(screen.queryByText('home')).not.toBeInTheDocument();
  });

  it('prompts to add details when there are none', () => {
    render(<PersonProfileCard person={{ name: 'Nobody' }} onEdit={vi.fn()} />);

    expect(screen.getByText(/No saved email, phone, or address/)).toBeInTheDocument();
  });

  it('shows the edit affordance only when editing is allowed', () => {
    const onEdit = vi.fn();
    const { rerender } = render(<PersonProfileCard person={PERSON} onEdit={onEdit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);

    // Read-only viewers (shared search) get the card without the button.
    rerender(<PersonProfileCard person={PERSON} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});
