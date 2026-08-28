import { destinationsFor } from '../../push/canonical';
import { DESTINATION_ORDER } from '../PushStage';

/**
 * `DESTINATION_ORDER` is a hand-maintained list, and `destinationsFor` is the
 * function it claims to be consistent with. Nothing connected the two, so the
 * batching refactor could invert `events`/`content` without a single test
 * noticing — and it did, leaving `ci.content.event_id` NULL on all 41,851 rows
 * of a real corpus and blanking every gallery thumbnail.
 *
 * These assert the RELATIONSHIP rather than the literal array, so they keep
 * holding when a destination is added.
 */
describe('DESTINATION_ORDER agrees with destinationsFor', () => {
  /** Kinds `destinationsFor` routes to more than one destination. */
  const MULTI_DESTINATION_KINDS = [
    'social.post',
    'media.play',
    'media.watch',
    'media.listen',
    'media.read',
    'capture.photo',
    'calendar.event',
    'communication.message',
    'commerce.purchase',
    'commerce.receipt',
  ];

  const rank = (d: string): number => DESTINATION_ORDER.indexOf(d as never);

  it.each(MULTI_DESTINATION_KINDS)(
    'writes %s destinations in the same relative order destinationsFor lists them',
    (kind) => {
      // A file-bearing record, so the branches gated on a file are exercised too.
      // `metadata` is NOT optional on a CanonicalRecord — all eleven reads in
      // canonical.ts dereference it directly. Omitting it here made this
      // fixture pass only for as long as no branch on the path happened to
      // read it; #2152 added `isSocialAffiliation`, which reads
      // `rec.metadata.Kind`, and the test began throwing instead of asserting.
      const rec = {
        kind,
        metadata: {},
        mediaType: 'image/jpeg',
        mediaPath: '/tmp/x.jpg',
      } as never;
      const destinations = destinationsFor(rec);

      // Assert membership BEFORE ordering. Filtering unranked destinations out
      // — which this test did — discards precisely the drift it exists to
      // catch: a destination dropped from DESTINATION_ORDER ranks -1, gets
      // filtered away, and the remaining list is still sorted, so the test
      // passes while that destination is never written at all.
      for (const destination of destinations) {
        expect(DESTINATION_ORDER).toContain(destination);
      }

      const ranks = destinations.map(rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    },
  );

  it('writes events before content, because content auto-links to its event by triple', () => {
    // The specific inversion that shipped. ContentService.createManyDetailed
    // resolves event_id by provenance triple at insert time, so a content row
    // written first can never find its event.
    expect(rank('events')).toBeLessThan(rank('content'));
  });

  it('still writes communications before content, for reddit', () => {
    // reddit is the one branch returning ['communications', 'content'].
    expect(rank('communications')).toBeLessThan(rank('content'));
  });

  it('writes product models before receipts, so a barcode resolves instead of re-minting', () => {
    // ReceiptService.upsertFromExtraction resolves a line's product by its
    // identifier claim first and only falls back to find-or-create when nothing
    // resolves. With receipts first, an ISBN this same batch is about to
    // catalogue mints a SECOND, brand+model-guessed product — and the claim
    // index is first-writer-wins, so the guess keeps the barcode forever.
    expect(rank('product_models')).toBeLessThan(rank('receipts'));
  });

  it('writes observations last, after the thing they sighted has an identity', () => {
    expect(rank('receipts')).toBeLessThan(rank('observations'));
  });

  it('keeps a receipt that is also correspondence in DESTINATION_ORDER order', () => {
    const rec = {
      kind: 'commerce.receipt',
      title: 'Your receipt from Apple',
      metadata: { HumanCorrespondence: true },
      mediaType: null,
      mediaPath: null,
    } as never;

    const ranks = destinationsFor(rec).map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('orders an identified physical purchase product → receipt → thing → observation', () => {
    const rec = {
      kind: 'commerce.purchase',
      title: 'Some Book',
      metadata: { Product: 'Some Book' },
      identifiers: [{ namespace: 'isbn', value: '9781451673319' }],
      mediaType: null,
      mediaPath: null,
    } as never;

    const ranks = destinationsFor(rec).map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
