import { type ReactNode } from 'react';

import { Badge, Button, Card } from '@ci/shadcn';
import { Pencil } from '@ci/shadcn/icons';

import type { PersonDraftSource } from './personDraft';

function labelFor(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();

  return trimmed ? trimmed : fallback;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-sm">{children}</span>
    </div>
  );
}

/** Format an address for display; falls back to the parts when unformatted. */
function formatAddress(address: NonNullable<PersonDraftSource['addresses']>[number]): string {
  return [
    address.streetAddress,
    address.streetAddress2,
    address.city,
    address.region,
    address.postalCode,
    address.country,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(', ');
}

interface Props {
  person: PersonDraftSource;
  onEdit?: () => void;
}

/**
 * The read side of the person editor: everything {@link PersonForm} can write,
 * rendered as a contact card. Sections with nothing in them are omitted rather
 * than shown as a column of dashes.
 */
export function PersonProfileCard({ person, onEdit }: Props) {
  const emails = (person.identifiers ?? []).filter((identifier) => identifier.kind === 'email');
  const phones = (person.identifiers ?? []).filter((identifier) => identifier.kind === 'phone');
  const addresses = (person.addresses ?? []).filter((address) => formatAddress(address) !== '');

  const work = [person.jobTitle, person.department, person.organization]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const rows: ReactNode[] = [];

  if (person.nickname) {
    rows.push(
      <Row key="nickname" label="Nickname">
        {person.nickname}
      </Row>,
    );
  }

  if (person.pronouns) {
    rows.push(
      <Row key="pronouns" label="Pronouns">
        {person.pronouns}
      </Row>,
    );
  }

  if (person.gender) {
    rows.push(
      <Row key="gender" label="Gender">
        {person.gender}
      </Row>,
    );
  }

  if (person.birthDate) {
    rows.push(
      <Row key="birthday" label="Birthday">
        {person.birthDate}
      </Row>,
    );
  }

  if (emails.length > 0) {
    rows.push(
      <Row key="email" label="Email">
        <div className="flex flex-col gap-1">
          {emails.map((email) => (
            <span key={`${email.kind}:${email.value}`} className="flex items-center gap-2">
              <a href={`mailto:${email.value}`} className="truncate hover:underline">
                {email.rawValue?.trim() || email.value}
              </a>
              {email.label && (
                <Badge variant="secondary" className="shrink-0">
                  {email.label}
                </Badge>
              )}
            </span>
          ))}
        </div>
      </Row>,
    );
  }

  if (phones.length > 0) {
    rows.push(
      <Row key="phone" label="Phone">
        <div className="flex flex-col gap-1">
          {phones.map((phone) => (
            <span key={`${phone.kind}:${phone.value}`} className="flex items-center gap-2">
              <a href={`tel:${phone.value}`} className="truncate hover:underline">
                {phone.rawValue?.trim() || phone.value}
              </a>
              {phone.label && (
                <Badge variant="secondary" className="shrink-0">
                  {phone.label}
                </Badge>
              )}
            </span>
          ))}
        </div>
      </Row>,
    );
  }

  for (const [index, address] of addresses.entries()) {
    rows.push(
      <Row key={`address-${index}`} label={labelFor(address.label, index === 0 ? 'Address' : 'Also at')}>
        {formatAddress(address)}
      </Row>,
    );
  }

  if (work) {
    rows.push(
      // "Job" rather than "Work": an address the user labelled "work" sits in
      // this same list, and two WORK rows read as a duplicate.
      <Row key="work" label="Job">
        {work}
      </Row>,
    );
  }

  if (person.website) {
    rows.push(
      <Row key="website" label="Website">
        <a
          href={person.website}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate hover:underline"
        >
          {person.website}
        </a>
      </Row>,
    );
  }

  return (
    <Card className="gap-0 border-border/60 bg-card/45 p-0 shadow-sm">
      <Card.Header className="flex flex-row items-center justify-between gap-2 p-4 pb-2">
        <Card.Title className="text-sm">Details</Card.Title>
        {onEdit && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="size-3.5" /> Edit
          </Button>
        )}
      </Card.Header>
      <Card.Content className="flex flex-col divide-y divide-border/50 p-4 pt-2">
        {rows.length > 0 ? (
          rows
        ) : (
          <p className="text-sm text-muted-foreground">
            No saved email, phone, or address
            {onEdit ? ' — add one if you have it.' : '.'}
          </p>
        )}
      </Card.Content>
    </Card>
  );
}
