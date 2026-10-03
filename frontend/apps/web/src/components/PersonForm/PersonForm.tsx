import { type ComponentType, type ReactNode, useId } from 'react';

import { Button, IconButton, Input, Label, Select, Textarea } from '@ci/shadcn';
import {
  Briefcase,
  Contact as ContactIcon,
  MapPin,
  Plus,
  StickyNote,
  Trash2,
  UserRound,
} from '@ci/shadcn/icons';

import { PersonAvatar } from '@/components/PersonAvatar';

import {
  type PersonAddressDraft,
  type PersonContactDraft,
  type PersonContactKind,
  type PersonDraft,
  composedName,
  emptyAddress,
  emptyContact,
} from './personDraft';
import { type RefusedContact, keepContactInNote, refusalFor } from './refusedContacts';

/**
 * Suggestions, not a closed set. Gender, pronouns and contact labels are stored
 * as free text (imports carry values no dropdown would predict), so these are
 * offered through a `datalist` — the user can always type their own, and an
 * imported value is never silently rewritten to fit an enum.
 */
const GENDER_SUGGESTIONS = ['Woman', 'Man', 'Non-binary', 'Prefer not to say'];
const PRONOUN_SUGGESTIONS = ['she/her', 'he/him', 'they/them'];
const CONTACT_LABEL_SUGGESTIONS = ['home', 'work', 'mobile', 'other'];
const ADDRESS_LABEL_SUGGESTIONS = ['home', 'work', 'mailing', 'other'];

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border/60 pt-5 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type,
  listId,
  autoFocus,
  errorId,
  inputClassName,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  listId?: string;
  autoFocus?: boolean;
  /** Id of the message saying what is wrong with the value, when something is. */
  errorId?: string;
  /** Extra classes for the input itself (the wrapper is not the thing to style). */
  inputClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        list={listId}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
        className={inputClassName}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** What is wrong with a refused contact row, and what can be done about it. */
function RefusedContactNote({
  id,
  refusal,
  onKeepInNote,
}: {
  id: string;
  refusal: RefusedContact;
  onKeepInNote: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p id={id} className="text-sm text-destructive">
        {refusal.reason === 'extension'
          ? "Has an extension, so it can't be matched to calls and messages."
          : `Not a ${refusal.kind === 'email' ? 'usable email address' : 'phone number that can be saved'}.`}
      </p>
      {/* Only an extension: it is a real number worth keeping. A "phone" with
          no digits is better fixed or removed than filed away. */}
      {refusal.reason === 'extension' && (
        <Button type="button" size="sm" variant="outline" onClick={onKeepInNote}>
          <StickyNote className="size-4" /> Keep it in a note
        </Button>
      )}
    </div>
  );
}

interface Props {
  value: PersonDraft;
  onChange: (next: PersonDraft) => void;
  /** Shown under the name field; set when the caller rejected an empty name. */
  nameError?: string | null;
  disabled?: boolean;
  /**
   * Focus "First name" on mount. Right for the modals — the dialog opened
   * *because* the user is about to type. Wrong for a form that is simply part
   * of a page: mounting it there scrolls the viewport to this field and, on a
   * phone, opens the keyboard over the page the user was trying to read.
   * Defaults on so the modal call sites keep the behaviour they were written
   * against.
   */
  autoFocusName?: boolean;
  /**
   * Contact values the last save was refused over (`refusedContactsFrom` the
   * error). Each is shown under the row still holding it — with an offer to move
   * an extension number into the notes — and drops off once the row changes.
   */
  refusedContacts?: readonly RefusedContact[];
}

/**
 * The full person editor — identity, contact methods, addresses, work, notes —
 * shared by the add and edit flows so the two can't drift apart.
 *
 * Contact methods and addresses are repeatable labelled rows rather than a
 * single field each: a person has a home address *and* a work one, a personal
 * email *and* a work email, and collapsing them loses which is which.
 */
export function PersonForm({
  value,
  onChange,
  nameError,
  disabled,
  autoFocusName = true,
  refusedContacts = [],
}: Props) {
  const uid = useId();
  const genderListId = `${uid}-genders`;
  const pronounListId = `${uid}-pronouns`;
  const contactLabelListId = `${uid}-contact-labels`;
  const addressLabelListId = `${uid}-address-labels`;

  const set = <K extends keyof PersonDraft>(key: K, next: PersonDraft[K]) => {
    onChange({ ...value, [key]: next });
  };

  const updateContact = (key: string, patch: Partial<PersonContactDraft>) => {
    set(
      'contacts',
      value.contacts.map((contact) => (contact.key === key ? { ...contact, ...patch } : contact)),
    );
  };

  const updateAddress = (key: string, patch: Partial<PersonAddressDraft>) => {
    set(
      'addresses',
      value.addresses.map((address) => (address.key === key ? { ...address, ...patch } : address)),
    );
  };

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
      <datalist id={genderListId}>
        {GENDER_SUGGESTIONS.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      <datalist id={pronounListId}>
        {PRONOUN_SUGGESTIONS.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      <datalist id={contactLabelListId}>
        {CONTACT_LABEL_SUGGESTIONS.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      <datalist id={addressLabelListId}>
        {ADDRESS_LABEL_SUGGESTIONS.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>

      <Section title="Identity" icon={UserRound}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            id={`${uid}-first-name`}
            label="First name"
            value={value.firstName}
            autoFocus={autoFocusName}
            onChange={(next) => set('firstName', next)}
          />
          <Field
            id={`${uid}-middle-name`}
            label="Middle name"
            value={value.middleName}
            onChange={(next) => set('middleName', next)}
          />
          <Field
            id={`${uid}-last-name`}
            label="Last name"
            value={value.lastName}
            onChange={(next) => set('lastName', next)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-name`} className="text-xs text-muted-foreground">
            Display name{' '}
            <span className="font-normal text-muted-foreground/70">(defaults to first + last)</span>
          </Label>
          <Input
            id={`${uid}-name`}
            value={value.name}
            placeholder="Full name"
            onChange={(event) => set('name', event.target.value)}
          />
          {nameError && <p className="text-sm text-destructive">{nameError}</p>}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            id={`${uid}-nickname`}
            label="Nickname"
            value={value.nickname}
            placeholder="What you actually call them"
            onChange={(next) => set('nickname', next)}
          />
          <Field
            id={`${uid}-pronouns`}
            label="Pronouns"
            value={value.pronouns}
            listId={pronounListId}
            placeholder="they/them"
            onChange={(next) => set('pronouns', next)}
          />
          <Field
            id={`${uid}-gender`}
            label="Gender"
            value={value.gender}
            listId={genderListId}
            onChange={(next) => set('gender', next)}
          />
          {/* iOS WebKit lays a native date input out as content-box with a forced
              min-width, so `w-full` came out ~28px wider than the card: the field
              stuck out of it and the page panned sideways. Without the native
              appearance it is an ordinary box again; the picker still opens, and
              the value stays left-aligned like its neighbours. */}
          <Field
            id={`${uid}-birth-date`}
            label="Birthday"
            type="date"
            value={value.birthDate}
            inputClassName="appearance-none [&::-webkit-date-and-time-value]:text-left"
            onChange={(next) => set('birthDate', next)}
          />
        </div>
      </Section>

      <Section title="Contact" icon={ContactIcon}>
        <div className="flex flex-col gap-2">
          {/* Two lines on a phone, one from `sm` up. The fixed columns here
              (type 6rem + label 7rem + remove 2.25rem + gaps) add up to
              ~17rem, which on a 390px phone left the email/phone input — the
              only field that actually matters — about three characters wide.
              `order-*` puts the value under the other three rather than
              between them once the row wraps. */}
          {value.contacts.map((contact) => {
            const refusal = refusalFor(contact, refusedContacts);
            const refusalId = `${uid}-${contact.key}-refused`;

            return (
              <div key={contact.key} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="order-1 flex w-24 shrink-0 flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Type</Label>
                    <Select
                      value={contact.kind}
                      onValueChange={(kind) =>
                        updateContact(contact.key, { kind: kind as PersonContactKind })
                      }
                    >
                      <Select.Trigger className="w-full">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="email">Email</Select.Item>
                        <Select.Item value="phone">Phone</Select.Item>
                      </Select.Content>
                    </Select>
                  </div>

                  <div className="order-4 w-full min-w-0 sm:order-2 sm:w-auto sm:flex-1">
                    <Field
                      id={`${uid}-${contact.key}-value`}
                      label={contact.kind === 'email' ? 'Email address' : 'Phone number'}
                      type={contact.kind === 'email' ? 'email' : 'tel'}
                      value={contact.value}
                      placeholder={contact.kind === 'email' ? 'name@example.com' : '+1 555 010 0100'}
                      errorId={refusal ? refusalId : undefined}
                      onChange={(next) => updateContact(contact.key, { value: next })}
                    />
                  </div>

                  <div className="order-2 min-w-0 flex-1 sm:order-3 sm:w-28 sm:flex-none">
                    <Field
                      id={`${uid}-${contact.key}-label`}
                      label="Label"
                      value={contact.label}
                      listId={contactLabelListId}
                      placeholder="home"
                      onChange={(next) => updateContact(contact.key, { label: next })}
                    />
                  </div>

                  <IconButton
                    type="button"
                    variant="ghost"
                    className="order-3 mb-0.5 size-9 shrink-0 sm:order-4"
                    label={`Remove ${contact.kind}`}
                    onClick={() =>
                      set(
                        'contacts',
                        value.contacts.filter((other) => other.key !== contact.key),
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>

                {refusal && (
                  <RefusedContactNote
                    id={refusalId}
                    refusal={refusal}
                    onKeepInNote={() => onChange(keepContactInNote(value, contact.key))}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => set('contacts', [...value.contacts, emptyContact('email')])}
          >
            <Plus className="size-4" /> Add email
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => set('contacts', [...value.contacts, emptyContact('phone')])}
          >
            <Plus className="size-4" /> Add phone
          </Button>
        </div>
      </Section>

      <Section title="Addresses" icon={MapPin}>
        <div className="flex flex-col gap-3">
          {value.addresses.map((address, index) => (
            <div key={address.key} className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field
                    id={`${uid}-${address.key}-label`}
                    label={index === 0 ? 'Label (primary address)' : 'Label'}
                    value={address.label}
                    listId={addressLabelListId}
                    placeholder="home"
                    onChange={(next) => updateAddress(address.key, { label: next })}
                  />
                </div>
                <IconButton
                  type="button"
                  variant="ghost"
                  className="mb-0.5 size-9 shrink-0"
                  label="Remove address"
                  onClick={() =>
                    set(
                      'addresses',
                      value.addresses.filter((other) => other.key !== address.key),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id={`${uid}-${address.key}-street`}
                  label="Street"
                  value={address.streetAddress}
                  onChange={(next) => updateAddress(address.key, { streetAddress: next })}
                />
                <Field
                  id={`${uid}-${address.key}-street-2`}
                  label="Apt, suite, floor"
                  value={address.streetAddress2}
                  onChange={(next) => updateAddress(address.key, { streetAddress2: next })}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field
                  id={`${uid}-${address.key}-city`}
                  label="City"
                  value={address.city}
                  onChange={(next) => updateAddress(address.key, { city: next })}
                />
                <Field
                  id={`${uid}-${address.key}-region`}
                  label="State / region"
                  value={address.region}
                  onChange={(next) => updateAddress(address.key, { region: next })}
                />
                <Field
                  id={`${uid}-${address.key}-postal-code`}
                  label="Postal code"
                  value={address.postalCode}
                  onChange={(next) => updateAddress(address.key, { postalCode: next })}
                />
                <Field
                  id={`${uid}-${address.key}-country`}
                  label="Country"
                  value={address.country}
                  onChange={(next) => updateAddress(address.key, { country: next })}
                />
              </div>
            </div>
          ))}
        </div>

        {/* Three nowrap buttons are ~368px wide: on a 390pt phone they overflowed
            the card and pushed the whole Self page ~5pt sideways. */}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => set('addresses', [...value.addresses, emptyAddress('home')])}
          >
            <Plus className="size-4" /> Add home
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => set('addresses', [...value.addresses, emptyAddress('work')])}
          >
            <Plus className="size-4" /> Add work
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => set('addresses', [...value.addresses, emptyAddress()])}
          >
            <Plus className="size-4" /> Add other
          </Button>
        </div>
      </Section>

      <Section title="Work" icon={Briefcase}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            id={`${uid}-job-title`}
            label="Job title"
            value={value.jobTitle}
            onChange={(next) => set('jobTitle', next)}
          />
          <Field
            id={`${uid}-organization`}
            label="Organization"
            value={value.organization}
            onChange={(next) => set('organization', next)}
          />
          <Field
            id={`${uid}-department`}
            label="Department"
            value={value.department}
            onChange={(next) => set('department', next)}
          />
          <Field
            id={`${uid}-website`}
            label="Website"
            type="url"
            value={value.website}
            placeholder="https://"
            onChange={(next) => set('website', next)}
          />
        </div>
      </Section>

      <Section title="Notes" icon={StickyNote}>
        <div className="flex items-end gap-3">
          {/* Live preview: the same fallback (initials on a deterministic
              colour) or broken-link handling this URL gets everywhere else
              it is rendered, shown as it is typed rather than only after
              saving. */}
          <PersonAvatar name={composedName(value)} avatarUrl={value.avatarUrl} size="lg" className="mb-1.5" />
          <div className="min-w-0 flex-1">
            <Field
              id={`${uid}-avatar-url`}
              label="Avatar URL"
              type="url"
              value={value.avatarUrl}
              placeholder="https://"
              onChange={(next) => set('avatarUrl', next)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-description`} className="text-xs text-muted-foreground">
            Description
          </Label>
          <Textarea
            id={`${uid}-description`}
            value={value.description}
            placeholder="How you know them, anything worth remembering"
            onChange={(event) => set('description', event.target.value)}
          />
        </div>
      </Section>
    </fieldset>
  );
}
