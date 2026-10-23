import { describe, expect, it } from 'vitest';

import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

import { detailRows, recordTypeLabel } from './recordDetail';

const fmt = {
  dateTime: (date: Date) => `dt:${date.toISOString()}`,
  date: (date: Date) => `d:${date.toISOString()}`,
  time: (date: Date) => `t:${date.toISOString()}`,
} as unknown as DateTimeFormatter;

describe('recordTypeLabel', () => {
  it('names each type the way the app does', () => {
    expect(recordTypeLabel('communication')).toBe('Message');
    expect(recordTypeLabel('item')).toBe('Thing');
    expect(recordTypeLabel('thread')).toBe('Chat');
    expect(recordTypeLabel('browser-activity')).toBe('Browser activity');
    expect(recordTypeLabel('file-chunk')).toBe('Document excerpt');
    // A type the table does not know is still readable.
    expect(recordTypeLabel('some-new-type')).toBe('Some New Type');
  });
});

describe('detailRows', () => {
  it('a message: kind, direction and participants, with the ids kept out', () => {
    const rows = detailRows(
      {
        communication_type: 'chat',
        direction: 'inbound',
        participants: { from: 'Ana', to: ['Kyle', 'Bo'] },
        participants_truncated: true,
        from_id: 'p1',
        to_ids: ['p2'],
        source_system: 'facebook_messenger',
      },
      fmt,
    );

    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['Kind', 'Chat'],
      ['Direction', 'Inbound'],
      ['Participants', 'From Ana · To Kyle, Bo · and more'],
      ['Source', 'Facebook Messenger'],
    ]);
  });

  it('a file: size in units and dimensions as one pair', () => {
    const rows = detailRows({ content_type: 'image/jpeg', size: 771691, width: 400, height: 302 }, fmt);

    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['Format', 'Image/jpeg'],
      ['Size', '753.6 KiB'],
      ['Dimensions', '400 × 302'],
    ]);
  });

  it('an event: coordinates as one pair, booleans as words, timestamps through the formatter', () => {
    const rows = detailRows(
      {
        end_time: '2026-01-02T10:00:00.000Z',
        is_all_day: false,
        lat: 33.6881268,
        lng: -117.7715063,
        people: ['p1'],
      },
      fmt,
    );

    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['Ends', expect.stringContaining('2026')],
      ['All day', 'No'],
      ['Coordinates', '33.6881, -117.7715'],
    ]);
  });

  it("an event's status shows only when a source stated one: the column default is not information", () => {
    const confirmed = detailRows({ status: 'confirmed', is_all_day: true }, fmt);
    expect(confirmed.map((row) => row.label)).toEqual(['All day']);

    const tentative = detailRows({ status: 'tentative' }, fmt);
    expect(tentative.map((row) => [row.label, row.value])).toEqual([['Status', 'tentative']]);

    const cancelled = detailRows({ status: 'cancelled' }, fmt);
    expect(cancelled.map((row) => [row.label, row.value])).toEqual([['Status', 'cancelled']]);
  });

  it('a receipt total with its currency, and a field this list has never heard of', () => {
    const rows = detailRows(
      { merchant_name: 'Home Depot', total_minor: 4599, currency: 'USD', warranty_until: '2027' },
      fmt,
    );

    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['Merchant', 'Home Depot'],
      ['Total', '45.99 USD'],
      ['Warranty Until', '2027'],
    ]);
  });

  it('nothing for a record with no detail', () => {
    expect(detailRows(null, fmt)).toEqual([]);
  });
});
