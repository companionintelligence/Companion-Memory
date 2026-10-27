import { useRef, useState } from 'react';

import { useLazyQuery } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { Button, Input, Select } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { ResponsiveDialog } from '@/components/ResponsiveDialog';
import { gql } from '@/graphql';
import type { ObjectIdentifierNamespace } from '@/graphql/graphql';

/**
 * Ask the identity ladder who owns a code.
 *
 * The lookup normalizes on the way in, which is why the payload echoes back a
 * `namespace` and `value` that may not be the ones asked for — a 12-digit UPC
 * widens to a GTIN-13, and a bare number typed as CUSTOM may resolve as one.
 *
 * Exported so tests mock the exact document this modal sends.
 */
export const OBJECT_BY_IDENTIFIER = gql(`
  query ScanObjectByIdentifier($namespace: ObjectIdentifierNamespace!, $value: String!) {
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

// Listed rather than derived: `enumsAsTypes` leaves no runtime object to
// iterate. Only the codes a person can actually read off an object are here —
// a scanner is not going to hand you an ORDER_ID.
const SCANNABLE_NAMESPACES = [
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
] as const satisfies readonly ObjectIdentifierNamespace[];

const NAMESPACE_LABELS: Record<(typeof SCANNABLE_NAMESPACES)[number], string> = {
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
};

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Type or scan a code and go straight to the thing that carries it.
 *
 * Deliberately a LOOKUP, not a create: `objectByIdentifier` is a read, and a
 * code that matches nothing is far more likely to be a thing not yet imported
 * than a reason to mint an empty row on the spot.
 */
export function ScanBarcodeModal({ open, onClose }: Props) {
  const navigate = useNavigate();

  const [namespace, setNamespace] = useState<ObjectIdentifierNamespace>('GTIN');
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  const [lookup, { loading }] = useLazyQuery(OBJECT_BY_IDENTIFIER, { fetchPolicy: 'network-only' });

  const close = () => {
    setValue('');
    setMessage(null);
    onClose();
  };

  const submit = async () => {
    const trimmed = value.trim();

    if (trimmed === '') {
      return;
    }

    setMessage(null);

    try {
      // `useLazyQuery`'s execute RESOLVES on a failed request rather than
      // rejecting, so a dead identity service arrives here as `error` with no
      // data — which the fall-through below would have reported as "nothing you
      // own carries that code", the one answer it definitely does not mean.
      const { data, error } = await lookup({ variables: { namespace, value: trimmed } });

      if (error) {
        setMessage(error.message);

        return;
      }

      const match = data?.objectByIdentifier;

      if (match?.item) {
        close();
        navigate(`/items/${GlobalUID.parse('item', match.item.id)}`);

        return;
      }

      if (match?.product) {
        // A GTIN identifies the MODEL, not the unit — a match on one says the
        // catalog knows the product but nothing you own carries the code.
        setMessage(
          `That code identifies "${match.product.title}", a product model. Nothing you own claims it yet.`,
        );

        return;
      }

      setMessage(`Nothing you own carries ${trimmed}.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The lookup failed. Please try again.');
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      <ResponsiveDialog.Content
        className="sm:max-w-[480px]"
        // Focus the code field through the dialog's own focus scope, not with
        // `autoFocus`. React's autoFocus runs at commit, before the scope starts
        // listening, so the scope never records the field as focused. Opened from
        // the + menu, the closing menu then hands focus back to its trigger, and
        // the trap has nothing to return it to: the sheet opened with nothing
        // focused on a phone. Focused here, the scope remembers it and pulls
        // focus straight back.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          codeInputRef.current?.focus();
        }}
      >
        <ResponsiveDialog.Header>
          <ResponsiveDialog.Title>Scan a code</ResponsiveDialog.Title>
          <ResponsiveDialog.Description>
            Point a scanner at a barcode, or type a serial number, to open the thing that carries it.
          </ResponsiveDialog.Description>
        </ResponsiveDialog.Header>

        <div className="flex flex-col gap-3">
          <Select value={namespace} onValueChange={(next) => setNamespace(next as ObjectIdentifierNamespace)}>
            <Select.Trigger aria-label="Code type">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {SCANNABLE_NAMESPACES.map((option) => (
                <Select.Item key={option} value={option}>
                  {NAMESPACE_LABELS[option]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>

          <Input
            ref={codeInputRef}
            aria-label="Code value"
            placeholder="Scan or type a code"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // A barcode scanner types the digits and presses Enter; without
              // this the one flow this dialog exists for would not work.
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />

          {message && <div className="text-sm text-muted-foreground">{message}</div>}
        </div>

        <ResponsiveDialog.Footer>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={loading || value.trim() === ''} onClick={() => void submit()}>
            {loading ? 'Looking up…' : 'Look up'}
          </Button>
        </ResponsiveDialog.Footer>
      </ResponsiveDialog.Content>
    </ResponsiveDialog>
  );
}
