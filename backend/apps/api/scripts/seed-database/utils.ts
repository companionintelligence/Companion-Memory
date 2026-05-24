import fs from 'fs';

import { parse } from 'csv-parse/sync';

function isIsoDate(value: string): boolean {
  // Checks for ISO date strings with optional timezone offset
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)?)?$/.test(value);
}

export function readCsv<T = Record<string, string | number | boolean | Date | null>>(filePath: string): T[] {
  const fileContent = fs.readFileSync(filePath, 'utf8');

  return parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cast: (value: any) => {
      if (value === '') {
        return null;
      }

      if (value === 'true') {
        return true;
      }

      if (value === 'false') {
        return false;
      }

      if (!isNaN(value) && value.trim() !== '') {
        return Number(value);
      }

      if (isIsoDate(value)) {
        return new Date(value);
      }

      return value;
    },
  }) as T[];
}

export function parseTags(value: string | null): string[] {
  if (value == null) {
    return [];
  }

  return value
    .slice(1, -1) // Remove the [ and ]
    .split(',') // Split by comma
    .map((s) => s.trim().replace(/^'(.*)'$/, '$1')); // remove single quotes
}
