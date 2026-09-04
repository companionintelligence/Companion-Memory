import { useState } from 'react';

import { useLazyQuery, useMutation } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { AlertDialog, Badge, Button, Input, Select } from '@ci/shadcn';
import { Merge, Trash2 } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { gql, useFragment, type FragmentType } from '@/graphql';
import type { ObjectIdentifierNamespace } from '@/graphql/graphql';

export const OBJECT_IDENTIFIER_FRAGMENT = gql(`
  fragment ObjectIdentifierData on ObjectIdentifierType {
    namespace
    value
    rawValue
    qualifier
    isPrimary
    confidence
    source
  }
`);

/** Exported so tests can assert on the exact variables the form sends. */
export const ADD_ITEM_IDENTIFIER = gql(`
  mutation AddItemIdentifier($input: AddItemIdentifierInput!) {
    addItemIdentifier(input: $input) {
      ...ObjectIdentifierData
    }
  }
`);

export const REMOVE_ITEM_IDENTIFIER = gql(`
  mutation RemoveItemIdentifier($input: RemoveItemIdentifierInput!) {
    removeItemIdentifier(input: $input) {
      ...ObjectIdentifierData
    }
  }
`);

// Who ALREADY holds the code the add was refused for. The backend deliberately
// does not steal the claim, so the only way to find the other side is to ask.
export const OBJECT_BY_IDENTIFIER = gql(`
  query ObjectByIdentifierLookup($namespace: ObjectIdentifierNamespace!, $value: String!) {
    objectByIdentifier(namespace: $namespace, value: $value) {
      matched
      namespace
      value
      subjectType
      confidence
      item {
        id
        name
        brand
        model
      }
      product {
        id
        title
        brand
      }
    }
  }
`);

export const MERGE_ITEMS = gql(`
  mutation MergeItemsFromIdentifier($input: MergeItemsInput!) {
    mergeItems(input: $input) {
      success
      item {
        id
        name
      }
    }
  }
`);

// Listed rather than derived: `enumsAsTypes` leaves no runtime object to
// iterate, and this is also the order the menu shows — the codes a person is
// most likely to be holding a scanner over come first.
const NAMESPACES = [
  'GTIN',
  'SERIAL',
  'ASIN',
  'SKU',
  'MPN',
  'ISBN',
  'IMEI',
  'VIN',
  'QR',
  'RFID',
  'ORDER_ID',
  'CUSTOM',
] as const satisfies readonly ObjectIdentifierNamespace[];

const NAMESPACE_LABELS: Record<ObjectIdentifierNamespace, string> = {
  GTIN: 'Barcode (GTIN)',
  SERIAL: 'Serial number',
  ASIN: 'Amazon ASIN',
  SKU: 'SKU',
  MPN: 'Manufacturer part',
  ISBN: 'ISBN',
  IMEI: 'IMEI',
  VIN: 'VIN',
  QR: 'QR code',
  RFID: 'RFID tag',
  ORDER_ID: 'Order number',
  CUSTOM: 'Other code',
};

/**
 * The server's refusal when a code is already claimed. Matched on text because
 * the mutation raises a plain ConflictException — there is no error code on the
 * wire to key off, and a `catch`-all would turn every failure (a bad value, a
 * dropped connection) into a merge offer for a thing that does not exist.
 */
const CONFLICT_MARKER = 'already belongs to another thing';

interface ConflictState {
  namespace: ObjectIdentifierNamespace;
  value: string;
  /** The thing that already holds the code, when the lookup found one. */
  otherItem: { id: string; name?: string | null } | null;
  /** A catalog MODEL holding it instead — no merge is possible with one. */
  otherProductTitle: string | null;
}

interface Props {
  /** GlobalUID-encoded item id — the mutations decode it server-side. */
  itemId: string;
  identifiers: readonly FragmentType<typeof OBJECT_IDENTIFIER_FRAGMENT>[];
  /** Re-read the thing after a write. Refetch, never hand-written cache surgery. */
  onChanged?: () => Promise<unknown> | void;
  /** Hide the add/remove affordances (shared or read-only views). */
  readOnly?: boolean;
}

/**
 * Every code that identifies one owned thing — the barcode on the box, the
 * serial on the plate, the order number it arrived under — with the two writes
 * that maintain them.
 *
 * Adding a code that another thing already claims is NOT an error to apologise
 * for: two things claiming one barcode is the strongest duplicate signal there
 * is. The list answers it by naming the other thing and offering the merge,
 * which is the fix the backend's first-writer-wins rule is pointing at.
 */
export function ObjectIdentifierList({ itemId, identifiers, onChanged, readOnly = false }: Props) {
  const rows = useFragment(OBJECT_IDENTIFIER_FRAGMENT, identifiers);

  const [namespace, setNamespace] = useState<ObjectIdentifierNamespace>('GTIN');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);

  const [addIdentifier, { loading: adding }] = useMutation(ADD_ITEM_IDENTIFIER);
  const [removeIdentifier, { loading: removing }] = useMutation(REMOVE_ITEM_IDENTIFIER);
  const [lookupIdentifier] = useLazyQuery(OBJECT_BY_IDENTIFIER, { fetchPolicy: 'network-only' });
  const [mergeItems, { loading: merging }] = useMutation(MERGE_ITEMS);

  const submit = async () => {
    const trimmed = value.trim();

    if (trimmed === '') {
      return;
    }

    setError(null);
    setConflict(null);

    try {
      await addIdentifier({ variables: { input: { itemId, namespace, value: trimmed } } });
      setValue('');
      await onChanged?.();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not add that code.';

      if (!message.includes(CONFLICT_MARKER)) {
        setError(message);

        return;
      }

      // Refused because someone else holds it. Find out who, so the offer can
      // name them rather than saying "another thing".
      const { data } = await lookupIdentifier({ variables: { namespace, value: trimmed } });
      const match = data?.objectByIdentifier;

      setConflict({
        namespace,
        value: trimmed,
        otherItem: match?.item ? { id: match.item.id, name: match.item.name } : null,
        otherProductTitle: match?.product?.title ?? null,
      });
    }
  };

  const remove = async (row: { namespace: ObjectIdentifierNamespace; value: string }) => {
    setError(null);

    try {
      await removeIdentifier({
        variables: { input: { itemId, namespace: row.namespace, value: row.value } },
      });
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove that code.');
    }
  };

  const merge = async () => {
    const otherId = conflict?.otherItem?.id;

    if (otherId == null) {
      return;
    }

    try {
      await mergeItems({ variables: { input: { targetId: itemId, sourceIds: [otherId] } } });
      setMergeOpen(false);
      setConflict(null);
      setValue('');
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The merge failed. Please try again.');
      setMergeOpen(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No codes on this thing yet.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            // The raw form is what is printed on the object; `value` is the
            // normalized matching key (a GTIN-12 widens to 13 digits), so
            // showing only the key would not match what the user is holding.
            // The Remove button's accessible name must track this same
            // displayed value — an aria-label built off the normalized value
            // instead diverges from what the user typed/sees whenever
            // normalization changes the string (e.g. a serial's hyphens are
            // stripped), which breaks "Label in Name" accessibility and any
            // lookup by that name.
            const displayValue = row.rawValue?.trim() || row.value;

            return (
              <li
                key={`${row.namespace}:${row.qualifier}:${row.value}`}
                className="flex items-center gap-2 rounded-md border p-2"
              >
                <Badge variant="secondary" className="shrink-0">
                  {NAMESPACE_LABELS[row.namespace] ?? row.namespace}
                </Badge>

                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm">{displayValue}</div>
                  {row.rawValue?.trim() && row.rawValue.trim() !== row.value && (
                    <div className="truncate text-xs text-muted-foreground">Normalized: {row.value}</div>
                  )}
                </div>

                {row.isPrimary && <Badge className="shrink-0">Primary</Badge>}
                {row.source && (
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {row.source}
                  </span>
                )}

                {!readOnly && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${displayValue}`}
                    disabled={removing}
                    onClick={() => void remove({ namespace: row.namespace, value: row.value })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={namespace} onValueChange={(next) => setNamespace(next as ObjectIdentifierNamespace)}>
            <Select.Trigger className="w-48" aria-label="Code type">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {NAMESPACES.map((option) => (
                <Select.Item key={option} value={option}>
                  {NAMESPACE_LABELS[option]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>

          <Input
            aria-label="Code value"
            placeholder="Scan or type a code"
            value={value}
            className="max-w-xs flex-1"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // A barcode scanner types the code and presses Enter; requiring a
              // click on Add would break the one flow this field exists for.
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />

          <Button disabled={adding || value.trim() === ''} onClick={() => void submit()}>
            {adding ? 'Adding…' : 'Add code'}
          </Button>
        </div>
      )}

      {error && <div className="text-sm text-destructive">{error}</div>}

      {conflict && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Merge className="h-4 w-4 shrink-0" />
            <span className="font-mono">{conflict.value}</span>
            <span>already belongs to</span>
            {conflict.otherItem ? (
              <Link
                to={`/items/${GlobalUID.parse('item', conflict.otherItem.id)}`}
                className="font-medium hover:underline"
              >
                {conflict.otherItem.name || 'another thing'}
              </Link>
            ) : (
              <span className="font-medium">{conflict.otherProductTitle ?? 'another thing'}</span>
            )}
            <span>.</span>
          </div>

          <p className="mt-1 text-xs text-muted-foreground">
            {conflict.otherItem
              ? 'One code means one thing. If these are the same object, merge them — the code is not re-assigned by hand.'
              : 'That code identifies a catalog model rather than an owned thing, so there is nothing to merge with.'}
          </p>

          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
              Dismiss
            </Button>
            {conflict.otherItem && (
              <Button size="sm" disabled={merging} onClick={() => setMergeOpen(true)}>
                Merge these things
              </Button>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Merge into one thing?</AlertDialog.Title>
            <AlertDialog.Description>
              {`Codes, sightings, receipt lines and object links from "${conflict?.otherItem?.name || 'the other thing'}" will move onto this one, and it will keep the code ${conflict?.value ?? ''}. This cannot be undone from the UI.`}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={merging}>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              disabled={merging}
              onClick={(e) => {
                // Radix auto-closes on Action click; keep it open so an
                // in-flight merge (or its failure) stays visible.
                e.preventDefault();
                void merge();
              }}
            >
              {merging ? 'Merging…' : 'Merge into one thing'}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </div>
  );
}
