import { type ReactNode } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, LoadingPage, usePageTitle } from '@ci/common';
import { Badge, Card, Table } from '@ci/shadcn';
import { Link, useParams } from 'react-router-dom';

import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { resolveMediaUrl } from '@/components/entities/resolveMediaUrl';
import { ReceiptIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';
import { namedChatContext } from '@/lib/agentChat';
import { formatMinor } from '@/lib/money';
import { humanizeEnum } from '@/lib/utils';

export const GET_RECEIPT = gql(`
  query GetReceipt($id: ID!) {
    receipt(id: $id) {
      id
      merchantName
      merchantEntityId
      placeEntityId
      purchasedAt
      orderNumber
      channel
      paymentMethod
      paymentLast4
      currency
      subtotalMinor
      taxMinor
      tipMinor
      shippingMinor
      discountMinor
      totalMinor
      extractionState
      extractionModel
      extractionConfidence
      extractionError
      documentContentId
      sourceFileId
      sourceSystem
      sourceType
      sourceMessageId
      eventId
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
        productId
      }
    }
  }
`);

// The source document (the emailed PDF, the scanned image) is a ci.content row
// referenced by id, so the evidence pane is a second read.
const GET_RECEIPT_DOCUMENT = gql(`
  query GetReceiptDocument($id: ID!) {
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

const GET_RECEIPT_PLACE = gql(`
  query GetReceiptPlace($id: ID!) {
    place(id: $id) {
      id
      name
    }
  }
`);

function TotalsRow({
  label,
  amount,
  strong = false,
}: {
  label: string;
  amount: string | null;
  strong?: boolean;
}) {
  if (amount == null) {
    return null;
  }

  return (
    <div className={`flex items-baseline justify-between gap-4 text-sm ${strong ? 'font-semibold' : ''}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{amount}</span>
    </div>
  );
}

function ReceiptPlace({ placeEntityId }: { placeEntityId: string }) {
  const { data } = useQuery(GET_RECEIPT_PLACE, { variables: { id: placeEntityId } });

  return (
    <Link to={`/places/${GlobalUID.parse('place', placeEntityId)}`} className="hover:underline">
      {data?.place?.name || 'View place'}
    </Link>
  );
}

/** The email, PDF or photo the structured receipt was extracted from. */
function EvidencePane({ documentContentId }: { documentContentId: string }) {
  const { data, loading } = useQuery(GET_RECEIPT_DOCUMENT, { variables: { id: documentContentId } });

  const content = data?.content;
  const mimetype = content?.mimetype ?? '';
  const previewSrc = resolveMediaUrl(content?.previewUrl) ?? resolveMediaUrl(content?.mediaUrl);
  const fileHref = resolveMediaUrl(content?.mediaUrl) ?? resolveMediaUrl(content?.url);

  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">Source document</Card.Title>
        <Card.Description>
          What the totals and lines above were extracted from. Everything else on this page is derived; this
          is the record.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        {loading && <div className="text-sm text-muted-foreground">Loading the source…</div>}

        {content?.title && <div className="truncate text-sm font-medium">{content.title}</div>}

        {mimetype.startsWith('image/') && previewSrc && (
          <img src={previewSrc} alt={content?.title ?? 'Receipt image'} className="max-h-96 rounded-md" />
        )}

        {mimetype === 'application/pdf' && fileHref && (
          <a href={fileHref} target="_blank" rel="noopener noreferrer" className="text-sm hover:underline">
            Open the PDF
          </a>
        )}

        {/* The extracted text is the fallback evidence for an emailed receipt,
            which has no image at all. */}
        {content?.text && (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
            {content.text}
          </pre>
        )}

        {!loading && content == null && (
          <div className="text-sm text-muted-foreground">The source document is no longer available.</div>
        )}
      </Card.Content>
    </Card>
  );
}

export function ReceiptPage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading } = useQuery(GET_RECEIPT, {
    variables: { id: GlobalUID.encode('receipt', id!) },
  });

  const receipt = data?.receipt;

  usePageTitle(
    receipt?.merchantName
      ? `Receipt - ${receipt.merchantName} - Companion Intelligence`
      : 'Receipt - Companion Intelligence',
  );

  let content: ReactNode | null = null;

  if (loading && receipt == null) {
    content = <LoadingPage />;
  } else if (receipt == null) {
    content = <EmptyState icon={<ReceiptIcon size={48} colorized={false} />} message="Receipt not found" />;
  } else {
    const purchasedAt = receipt.purchasedAt ? new Date(receipt.purchasedAt) : null;
    const dateLabel =
      purchasedAt && !Number.isNaN(purchasedAt.getTime()) ? purchasedAt.toLocaleString() : null;
    const currency = receipt.currency;

    content = (
      <PageContent>
        <div className="flex flex-wrap items-center gap-2">
          <ReceiptIcon />
          <h1 className="text-2xl font-bold">{receipt.merchantName || 'Unknown merchant'}</h1>
          {receipt.extractionState !== 'EXTRACTED' && (
            <Badge variant="secondary">{humanizeEnum(receipt.extractionState)}</Badge>
          )}
          <ChatWithAgentMenu
            context={namedChatContext({
              title: receipt.merchantName,
              body: [
                formatMinor(receipt.totalMinor, receipt.currency),
                dateLabel,
                receipt.orderNumber ? `#${receipt.orderNumber}` : null,
              ]
                .filter(Boolean)
                .join(' · '),
              sourceKind: 'ReceiptType',
              sourceId: receipt.id,
            })}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="md:col-span-2">
            <Card.Header>
              <Card.Title className="text-base">Purchase</Card.Title>
            </Card.Header>
            <Card.Content className="flex flex-col gap-2 text-sm">
              {dateLabel && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Date</span>
                  <span>{dateLabel}</span>
                </div>
              )}
              {receipt.placeEntityId && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Place</span>
                  <ReceiptPlace placeEntityId={receipt.placeEntityId} />
                </div>
              )}
              {receipt.orderNumber && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Order</span>
                  <span className="truncate">{receipt.orderNumber}</span>
                </div>
              )}
              {receipt.channel && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Channel</span>
                  <span>{humanizeEnum(receipt.channel)}</span>
                </div>
              )}
              {(receipt.paymentMethod || receipt.paymentLast4) && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Payment</span>
                  {/* Last four only — the backend never stores a full card
                      number, so there is nothing else that could be shown. */}
                  <span>
                    {[receipt.paymentMethod, receipt.paymentLast4 && `•••• ${receipt.paymentLast4}`]
                      .filter(Boolean)
                      .join(' ')}
                  </span>
                </div>
              )}
              {receipt.extractionError && (
                <div className="text-destructive">Extraction failed: {receipt.extractionError}</div>
              )}
            </Card.Content>
          </Card>

          <Card>
            <Card.Header>
              <Card.Title className="text-base">Totals</Card.Title>
            </Card.Header>
            <Card.Content className="flex flex-col gap-1">
              <TotalsRow label="Subtotal" amount={formatMinor(receipt.subtotalMinor, currency)} />
              <TotalsRow label="Discount" amount={formatMinor(receipt.discountMinor, currency)} />
              <TotalsRow label="Shipping" amount={formatMinor(receipt.shippingMinor, currency)} />
              <TotalsRow label="Tax" amount={formatMinor(receipt.taxMinor, currency)} />
              <TotalsRow label="Tip" amount={formatMinor(receipt.tipMinor, currency)} />
              <TotalsRow label="Total" amount={formatMinor(receipt.totalMinor, currency)} strong />
            </Card.Content>
          </Card>
        </div>

        <Card>
          <Card.Header>
            <Card.Title className="text-base">Line items</Card.Title>
            <Card.Description>
              Physical lines mint an owned thing; ebooks, subscriptions and gift cards do not.
            </Card.Description>
          </Card.Header>
          <Card.Content className="overflow-x-auto">
            {receipt.lineItems.length === 0 ? (
              <div className="py-2 text-sm text-muted-foreground">No line items were extracted.</div>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head className="w-10">#</Table.Head>
                    <Table.Head>Description</Table.Head>
                    <Table.Head className="text-right">Qty</Table.Head>
                    <Table.Head className="text-right">Unit</Table.Head>
                    <Table.Head className="text-right">Total</Table.Head>
                    <Table.Head>Thing</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {receipt.lineItems.map((line) => (
                    <Table.Row key={line.id}>
                      <Table.Cell className="tabular-nums text-muted-foreground">
                        {line.lineNumber}
                      </Table.Cell>
                      <Table.Cell>
                        <div className="font-medium">{line.description}</div>
                        <div className="text-xs text-muted-foreground">
                          {[line.brand, line.modelNumber, line.category].filter(Boolean).join(' · ')}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums">{line.quantity}</Table.Cell>
                      <Table.Cell className="text-right tabular-nums">
                        {formatMinor(line.unitPriceMinor, line.currency ?? currency) ?? '—'}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums">
                        {formatMinor(line.totalPriceMinor, line.currency ?? currency) ?? '—'}
                      </Table.Cell>
                      <Table.Cell>
                        {line.mintedObjectId ? (
                          <Link
                            to={`/items/${GlobalUID.parse('item', line.mintedObjectId)}`}
                            className="hover:underline"
                          >
                            Open thing
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {line.isPhysical ? 'Not yet minted' : 'Not physical'}
                          </span>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </Card.Content>
        </Card>

        {receipt.documentContentId && <EvidencePane documentContentId={receipt.documentContentId} />}
      </PageContent>
    );
  }

  return <>{content}</>;
}
