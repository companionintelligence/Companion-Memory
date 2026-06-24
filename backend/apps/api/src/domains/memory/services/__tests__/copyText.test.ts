import type { CopyColumn } from '../../types/bulkIngest';
import { buildCopyStatement, buildStagingDdl, encodeCopyField, encodeCopyRow } from '../copyText';

describe('encodeCopyField', () => {
  it('renders null and undefined as the COPY null marker', () => {
    expect(encodeCopyField(null)).toBe('\\N');
    expect(encodeCopyField(undefined)).toBe('\\N');
  });

  it('passes plain strings through untouched', () => {
    expect(encodeCopyField('hello world')).toBe('hello world');
  });

  it('escapes the COPY-text delimiters so they cannot break the row', () => {
    // A tab would otherwise be read as a column separator; a newline as a row
    // separator; a backslash as the start of an escape.
    expect(encodeCopyField('a\tb')).toBe('a\\tb');
    expect(encodeCopyField('line1\nline2')).toBe('line1\\nline2');
    expect(encodeCopyField('carriage\rreturn')).toBe('carriage\\rreturn');
    expect(encodeCopyField('back\\slash')).toBe('back\\\\slash');
  });

  it('escapes backslash before whitespace controls (order matters)', () => {
    // "\t" the literal two chars must become "\\t", NOT "\<tab>".
    expect(encodeCopyField('\\t')).toBe('\\\\t');
  });

  it('renders booleans as t/f and numbers as text', () => {
    expect(encodeCopyField(true)).toBe('t');
    expect(encodeCopyField(false)).toBe('f');
    expect(encodeCopyField(42)).toBe('42');
    expect(encodeCopyField(0)).toBe('0');
  });

  it('treats an empty string as an empty field (not null)', () => {
    expect(encodeCopyField('')).toBe('');
  });
});

describe('encodeCopyRow', () => {
  interface Row {
    a: string;
    b: number | null;
    c?: string;
  }

  const columns: CopyColumn<Row>[] = [
    { name: 'a', get: (r) => r.a },
    { name: 'b', get: (r) => r.b },
    { name: 'c', get: (r) => r.c },
  ];

  it('joins encoded columns with tabs in spec order', () => {
    expect(encodeCopyRow({ a: 'x', b: 1, c: 'y' }, columns)).toBe('x\t1\ty');
  });

  it('emits \\N for absent/null columns', () => {
    expect(encodeCopyRow({ a: 'x', b: null }, columns)).toBe('x\t\\N\t\\N');
  });

  it('escaping inside a column does not introduce a phantom delimiter', () => {
    const encoded = encodeCopyRow({ a: 'has\ttab', b: 2, c: 'has\nnewline' }, columns);
    // The embedded tab/newline are escaped, so the row still splits into exactly
    // the 3 declared columns on a REAL tab — no phantom delimiter slips in.
    expect(encoded.split('\t')).toHaveLength(3);
    expect(encoded).toBe('has\\ttab\t2\thas\\nnewline');
    expect(encoded).not.toContain('\n');
  });
});

describe('buildCopyStatement', () => {
  it('quotes columns and targets the staging table', () => {
    expect(buildCopyStatement('bulk_stage_events', [{ name: 'title' }, { name: 'start_time' }])).toBe(
      'COPY bulk_stage_events ("title", "start_time") FROM STDIN',
    );
  });
});

describe('buildStagingDdl', () => {
  it('creates a TEMP table that drops on commit', () => {
    const ddl = buildStagingDdl('bulk_stage_events', [
      { name: 'title', ddl: 'TEXT' },
      { name: 'start_time', ddl: 'TIMESTAMPTZ' },
    ]);
    expect(ddl).toBe(
      'CREATE TEMP TABLE bulk_stage_events ("title" TEXT, "start_time" TIMESTAMPTZ) ON COMMIT DROP',
    );
  });
});
