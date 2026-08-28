import { INGEST_REFRESH_COLUMNS, INGEST_SCHEMA_VERSION } from '../ingestRefreshColumns';

/**
 * Guards the centralized ingest conflict-refresh contract. The services import
 * the map (Communication's self-heal UPDATE; Event/Item/BrowserActivity's
 * conflictUpdateColumns), so THIS snapshot is the single place a column-list
 * change surfaces: changing a list must bump INGEST_SCHEMA_VERSION and update
 * the snapshot together.
 */
describe('INGEST_REFRESH_COLUMNS', () => {
  it('covers every bulk-ingest entity, exactly', () => {
    expect(Object.keys(INGEST_REFRESH_COLUMNS).sort()).toEqual(
      [
        'browser_activity',
        'communication',
        'content',
        'event',
        'item',
        'product_model',
        'receipt',
        'receipt_line_item',
        'object_observation',
      ].sort(),
    );
  });

  it('matches the versioned snapshot (bump INGEST_SCHEMA_VERSION when a list changes)', () => {
    expect({ version: INGEST_SCHEMA_VERSION, columns: INGEST_REFRESH_COLUMNS }).toEqual({
      version: 3,
      columns: {
        // CommunicationService.createMany self-heal UPDATE binds its VALUES
        // parameters in this order — keep it in lockstep with the service.
        communication: ['direction', 'participants_metadata', 'metadata', 'content', 'preview', 'subject'],
        event: [],
        // Empty is the contract, not an oversight: things is the one ingest
        // table a user edits directly, and a refresh list would let the next
        // re-sync clobber those edits. See the note on the map.
        item: [],
        content: [],
        browser_activity: [],
        product_model: [
          'title',
          'brand',
          'manufacturer',
          'model_number',
          'category',
          'subcategory',
          'product_type',
          'description',
          'variant_attributes',
          'spec',
          'msrp_minor',
          'currency',
          'is_digital',
        ],
        receipt: [
          'merchant_name',
          'purchased_at',
          'currency',
          'subtotal_minor',
          'tax_minor',
          'tip_minor',
          'shipping_minor',
          'discount_minor',
          'total_minor',
          'payment_method',
          'payment_last4',
          'order_number',
          'channel',
          'extraction_state',
          'extraction_confidence',
          'extraction_model',
          'extraction_error',
          'raw_text',
        ],
        receipt_line_item: [
          'description',
          'quantity',
          'unit_price_minor',
          'total_price_minor',
          'currency',
          'brand',
          'model_number',
          'category',
          'is_physical',
        ],
        object_observation: [],
      },
    });
  });

  it('never lists a SERVER-RESOLVED link (a refresh would un-link what enrichment joined)', () => {
    // The object tables carry pointers nothing on the wire owns: the graph
    // entity a merchant/place resolved to, the catalog product a barcode
    // resolved to, the unit a line minted. Re-ingesting the source row must not
    // reset them — the source never knew them.
    const resolved = [
      'product_entity_id',
      'merchant_entity_id',
      'place_entity_id',
      'event_id',
      'document_content_id',
      'image_content_id',
      'manual_content_ids',
      'product_id',
      'minted_object_id',
      'resolved_object_id',
      'resolved_product_id',
      'merged_into_product_id',
      'merged_into_object_id',
      'confirmed_by_user',
    ];
    for (const columns of Object.values(INGEST_REFRESH_COLUMNS)) {
      for (const column of columns) {
        expect(resolved).not.toContain(column);
      }
    }
  });

  it('never lists identity/arbiter columns (a refresh would clobber provenance)', () => {
    const forbidden = ['id', 'time', 'user_id', 'owner_user_id', 'source_type', 'source_system', 'source_id'];
    for (const columns of Object.values(INGEST_REFRESH_COLUMNS)) {
      for (const column of columns) {
        expect(forbidden).not.toContain(column);
      }
    }
  });
});
