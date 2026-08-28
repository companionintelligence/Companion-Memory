import { type ReactNode } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { type ResultOf } from '@graphql-typed-document-node/core';

import { RECEIPT_FRAGMENT } from '@/components/entities/grid/ReceiptGridItem';
import { gql, useFragment } from '@/graphql';
import { formatMinor } from '@/lib/money';

import type { MemoryEntityOf } from '../../useEntityService';

import { DocumentFileActions } from './DocumentFileActions';
import { useEntityDrawerHost } from './drawerHost';
import { EntityDetailScaffold, EntityMedia, resolveStaticUrl } from './EntityDetailScaffold';
import { useReadOnly } from './readOnly';

// The grid/search fragment that opened the drawer carries only `lineItems { id }`
// — enough to count them, not to show them. The lines themselves, and the id of
// the document they were extracted from, are read here so the drawer holds the
// whole receipt instead of pointing at a page that holds it.
export const GET_RECEIPT_LINES = gql(`
  query GetReceiptLinesForDrawer($id: ID!) {
    receipt(id: $id) {
      id
      currency
      documentContentId
      lineItems {
        id
        lineNumber
        description
        brand
        modelNumber
        category
        quantity
        unitPriceMinor
        totalPriceMinor
        currency
        isPhysical
        mintedObjectId
      }
    }
  }
`);

// The source document (the emailed PDF, the scanned photo) is a ci.content row
// referenced by id, so the evidence is a second read.
export const GET_RECEIPT_DOCUMENT = gql(`
  query GetReceiptDocumentForDrawer($id: ID!) {
    content(id: $id) {
      id
      title
      mimetype
      url
      mediaUrl
      previewUrl
      text
    }
  }
`);

type ReceiptLine = NonNullable<ResultOf<typeof GET_RECEIPT_LINES>['receipt']>['lineItems'][number];

/** The card shell the scaffold uses for its own sections, so these match it. */
const SECTION_CLASS = 'gap-0 border-border/60 bg-card/45 p-0 shadow-sm backdrop-blur';

/**
 * Raw graph id for the thing a line minted, or null when there is none. The id
 * is decoded rather than parsed-and-thrown: a malformed one should cost the row
 * its link, not take down the drawer.
 */
function mintedItemId(mintedObjectId?: string | null): string | null {
  if (!mintedObjectId) {
    return null;
  }

  try {
    return GlobalUID.parse('item', mintedObjectId);
  } catch {
    return null;
  }
}

function LineItemRow({
  line,
  currency,
  onOpenThing,
}: {
  line: ReceiptLine;
  currency?: string | null;
  /** Absent in read-only mode, where the owner's things aren't reachable. */
  onOpenThing?: (rawItemId: string) => void;
}) {
  const lineCurrency = line.currency ?? currency;
  const unit = formatMinor(line.unitPriceMinor, lineCurrency);
  const total = formatMinor(line.totalPriceMinor, lineCurrency);
  const mintedId = mintedItemId(line.mintedObjectId);
  // Quantity is only worth spelling out past one, and then beside the unit
  // price the line total can be checked against.
  const facts = [
    line.quantity > 1 ? `${line.quantity} × ${unit ?? '—'}` : null,
    line.brand,
    line.modelNumber,
    line.category,
  ]
    .filter(Boolean)
    .join(' · ');

  let thing: ReactNode;

  if (mintedId && onOpenThing) {
    thing = (
      <Button
        variant="link"
        size="sm"
        className="h-auto w-fit justify-start p-0 text-xs"
        onClick={() => onOpenThing(mintedId)}
      >
        Open thing
      </Button>
    );
  } else if (mintedId) {
    thing = <span className="text-xs text-muted-foreground">Minted a thing</span>;
  } else {
    thing = (
      <span className="text-xs text-muted-foreground">
        {line.isPhysical ? 'Not yet minted' : 'Not physical'}
      </span>
    );
  }

  return (
    <div className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="break-words text-sm text-foreground/90">{line.description}</span>
        {facts && <span className="break-words text-xs text-muted-foreground">{facts}</span>}
        {thing}
      </div>
      <span className="shrink-0 text-sm tabular-nums text-foreground/90">{total ?? unit ?? '—'}</span>
    </div>
  );
}

/**
 * The extracted lines, stacked rather than tabled: the sheet is a phone-width
 * column, where the full page's six columns would wrap into noise.
 */
function LineItemsSection({
  lines,
  currency,
  pending,
  onOpenThing,
}: {
  lines: readonly ReceiptLine[];
  currency?: string | null;
  pending: boolean;
  onOpenThing?: (rawItemId: string) => void;
}) {
  return (
    <Card className={SECTION_CLASS}>
      <Card.Header className="p-4 pb-2">
        <Card.Title className="text-sm">Line items</Card.Title>
        {lines.length > 0 && (
          <Card.Description className="text-xs">
            Physical lines mint an owned thing; ebooks, subscriptions and gift cards do not.
          </Card.Description>
        )}
      </Card.Header>
      <Card.Content className="flex flex-col divide-y divide-border/50 p-4 pt-0">
        {pending && <span className="text-sm text-muted-foreground">Loading the lines…</span>}

        {!pending && lines.length === 0 && (
          <span className="text-sm text-muted-foreground">No line items were extracted.</span>
        )}

        {lines.map((line) => (
          <LineItemRow key={line.id} line={line} currency={currency} onOpenThing={onOpenThing} />
        ))}
      </Card.Content>
    </Card>
  );
}

/** The email, PDF or photo the structured receipt was extracted from. */
function SourceDocumentSection({ documentContentId }: { documentContentId: string }) {
  const { data, loading } = useQuery(GET_RECEIPT_DOCUMENT, { variables: { id: documentContentId } });

  const content = data?.content;
  const mimetype = content?.mimetype ?? '';
  const fileSrc = resolveStaticUrl(content?.mediaUrl ?? content?.url);
  const previewSrc = resolveStaticUrl(content?.previewUrl);

  return (
    <Card className={SECTION_CLASS}>
      <Card.Header className="p-4 pb-2">
        <Card.Title className="text-sm">Source document</Card.Title>
        <Card.Description className="text-xs">
          What the totals and lines were extracted from. Everything else here is derived; this is the record.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3 p-4 pt-0">
        {loading && content == null && (
          <span className="text-sm text-muted-foreground">Loading the source…</span>
        )}

        {content?.title && <span className="truncate text-sm font-medium">{content.title}</span>}

        {mimetype.startsWith('image/') && (
          <EntityMedia
            src={fileSrc}
            previewSrc={previewSrc}
            contentType={mimetype}
            alt={content?.title ?? 'Receipt image'}
            fallbackHref={fileSrc}
          />
        )}

        {fileSrc && !mimetype.startsWith('image/') && (
          <DocumentFileActions href={fileSrc} filename={content?.title} />
        )}

        {/* The extracted text is the fallback evidence for an emailed receipt,
            which has no image at all. */}
        {content?.text && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-3 text-xs leading-relaxed text-foreground/85">
            {content.text}
          </pre>
        )}

        {!loading && content == null && (
          <span className="text-sm text-muted-foreground">The source document is no longer available.</span>
        )}
      </Card.Content>
    </Card>
  );
}

interface Props {
  entity: MemoryEntityOf<'ReceiptType'>;
}

/**
 * A purchase document, held whole by the drawer: the totals, every extracted
 * line, and the source document those were read from. Read-only — the fields
 * are extraction output rather than user input — and the only way out is into
 * the thing a physical line minted, which opens in this same sheet.
 *
 * `/receipts/:id` still renders the same record for a direct visit (a shared
 * link, a bookmark); nothing in here links to it.
 */
export function ReceiptDetails({ entity }: Props) {
  const data = useFragment(RECEIPT_FRAGMENT, entity);
  const { setActiveEntity } = useEntityDrawerHost();
  // Shared-search viewer: the owner's things resolve under the VIEWER's scope,
  // so the lines state what they minted without offering to open it.
  const readOnly = useReadOnly();

  // Cached after the first open, and shared with the full page's own read.
  const { data: linesData, loading } = useQuery(GET_RECEIPT_LINES, { variables: { id: entity.id } });
  const receipt = linesData?.receipt;
  const lines = receipt?.lineItems ?? [];

  const purchasedAt = data.purchasedAt ? new Date(data.purchasedAt) : null;
  const lineCount = data.lineItems.length;

  // Swapping the drawer to the minted thing is the move a relationship card
  // makes — the user stays in the sheet rather than being sent to a page.
  const openThing = readOnly
    ? undefined
    : (rawItemId: string) =>
        setActiveEntity({ __typename: 'GenericEntity', id: rawItemId, entityType: 'item' });

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.merchantName || 'Receipt'}
      subtitle="Receipt"
      taggable
      detailSections={
        <>
          {(loading || receipt != null) && (
            <LineItemsSection
              lines={lines}
              currency={receipt?.currency ?? data.receiptCurrency}
              pending={loading && lines.length === 0}
              onOpenThing={openThing}
            />
          )}

          {receipt?.documentContentId && (
            <SourceDocumentSection documentContentId={receipt.documentContentId} />
          )}
        </>
      }
      metaItems={[
        { label: 'Total', value: formatMinor(data.totalMinor, data.receiptCurrency) },
        {
          label: 'Purchased',
          value:
            purchasedAt && !Number.isNaN(purchasedAt.getTime()) ? purchasedAt.toLocaleDateString() : null,
        },
        { label: 'Order number', value: data.orderNumber },
        { label: 'Lines', value: lineCount > 0 ? String(lineCount) : null },
        { label: 'Extraction', value: data.extractionState },
      ]}
      rawData={receipt ?? data}
    />
  );
}
