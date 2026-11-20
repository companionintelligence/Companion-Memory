import { parseCSV } from '../csv';

// A header that repeats names the way Strava's activities.csv does, plus the
// quirks the reader already handles: a BOM, CRLF, padded cells, an escaped
// quote, a quoted newline, a blank row and a short (ragged) row.
const TEXT =
  '﻿Activity ID, Distance ,Note,Distance,Elapsed Time,Elapsed Time\r\n' +
  '1, 6.12 ,"said ""hi"", twice",6120.0,1980,1980.0\r\n' +
  ',,,,,\r\n' +
  '2,31.80,"two\nlines",31800.0,4620\r\n';

describe('parseCSV', () => {
  // Every other importer reads through the default path. These strings are
  // what it returned before the duplicate-header option existed; they must
  // not change by a byte.
  it('keeps the default output byte-for-byte: a repeated name holds its last column', () => {
    expect(JSON.stringify(parseCSV(TEXT))).toBe(
      '[{"Activity ID":"1","Distance":"6120.0","Note":"said \\"hi\\", twice","Elapsed Time":"1980.0"},' +
        '{"Activity ID":"2","Distance":"31800.0","Note":"two\\nlines","Elapsed Time":""}]',
    );
    expect(JSON.stringify(parseCSV(TEXT, { trimValues: false, omitEmpty: true }))).toBe(
      '[{"Activity ID":"1","Distance":"6120.0","Note":"said \\"hi\\", twice","Elapsed Time":"1980.0"},' +
        '{"Activity ID":"2","Distance":"31800.0","Note":"two\\nlines","Elapsed Time":"4620"}]',
    );
    expect(parseCSV(TEXT, { suffixDuplicateHeaders: false })).toEqual(parseCSV(TEXT));
  });

  it('names repeated headers `name.1`, `name.2` when asked', () => {
    expect(parseCSV(TEXT, { suffixDuplicateHeaders: true })).toEqual([
      {
        'Activity ID': '1',
        Distance: '6.12',
        Note: 'said "hi", twice',
        'Distance.1': '6120.0',
        'Elapsed Time': '1980',
        'Elapsed Time.1': '1980.0',
      },
      {
        'Activity ID': '2',
        Distance: '31.80',
        Note: 'two\nlines',
        'Distance.1': '31800.0',
        'Elapsed Time': '4620',
        'Elapsed Time.1': '',
      },
    ]);
    expect(Object.keys(parseCSV('a,b,a,a\n1,2,3,4\n', { suffixDuplicateHeaders: true })[0])).toEqual([
      'a',
      'b',
      'a.1',
      'a.2',
    ]);
  });

  it('never gives two columns the same key when a suffix is already a header', () => {
    expect(parseCSV('a,a,a.1\n1,2,3\n', { suffixDuplicateHeaders: true })).toEqual([
      { a: '1', 'a.2': '2', 'a.1': '3' },
    ]);
  });
});
