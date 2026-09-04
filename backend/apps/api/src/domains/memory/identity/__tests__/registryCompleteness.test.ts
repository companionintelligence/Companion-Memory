import * as fs from 'fs';
import * as path from 'path';

import { canonicalSystem, isRegisteredSystem } from '../registry';

/**
 * Registry completeness — the soft gate from
 * docs/design/cross-pipeline-identity.md §7.
 *
 * The branded types make an ad-hoc `source_system` a compile error, but the
 * string an author hands to `platformIdentity(...)` / `canonicalSystem(...)`
 * is still free text. This test walks the backend source, extracts every such
 * literal (plus the importer datasource registry names and any remaining
 * legacy `source_system: '...'` stamp), and asserts each resolves to a
 * registered canonical name. Adding a connection or datasource with an
 * unregistered name fails HERE with instructions, not silently in prod data.
 */

const SRC_ROOT = path.resolve(__dirname, '../../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !full.includes('__tests__')
    ) {
      out.push(full);
    }
  }

  return out;
}

interface Found {
  file: string;
  literal: string;
}

function extractSystemLiterals(): Found[] {
  const found: Found[] = [];
  const patterns = [
    // Constructor calls: the first string argument names the system.
    /\b(?:platformIdentity|canonicalSystem|emailFallbackIdentity)\(\s*'([^']+)'/g,
    // Legacy direct stamps that survive on plain-string fields (source_type
    // excluded — it is provenance, not identity).
    /\bsource_system:\s*'([^']+)'/g,
    /\bsourceSystem:\s*'([^']+)'/g,
    /\bSOURCE_SYSTEM\s*=\s*'([^']+)'/g,
    // Importer datasource registry names (each datasource descriptor's `name:`
    // becomes items.data_source becomes rec.sourceSystem).
  ];

  for (const file of walk(SRC_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) != null) {
        found.push({ file: path.relative(SRC_ROOT, file), literal: match[1] });
      }
    }
  }

  return found;
}

function extractDatasourceNames(): Found[] {
  const found: Found[] = [];
  const dir = path.join(SRC_ROOT, 'domains/import/datasources');
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.includes('.test.') || entry.includes('.spec.')) {
      continue;
    }

    const text = fs.readFileSync(path.join(dir, entry), 'utf8');
    // The descriptor object: `name: 'snake_case_name',` near the DataSource
    // export. Registry.ts itself declares interfaces, not descriptors.
    if (entry === 'registry.ts' || entry === 'index.ts') {
      continue;
    }

    const match = text.match(/^\s*name:\s*'([a-z0-9_]+)',/m);
    if (match) {
      found.push({ file: `domains/import/datasources/${entry}`, literal: match[1] });
    }
  }

  return found;
}

describe('identity registry completeness', () => {
  const allowlist = new Set<string>([
    // Doc examples / placeholder strings that never reach the write path.
    'some_new_importer',
    '<platform>',
    'x',
  ]);

  it('every source_system literal in the backend resolves to a registered name', () => {
    const offenders = extractSystemLiterals()
      .filter(({ literal }) => !allowlist.has(literal))
      .filter(({ literal }) => !isRegisteredSystem(canonicalSystem(literal) as string));

    expect(offenders.map(({ file, literal }) => `${literal} (${file})`)).toEqual([]);
  });

  it('every importer datasource name resolves to a registered name', () => {
    const offenders = extractDatasourceNames().filter(
      ({ literal }) => !isRegisteredSystem(canonicalSystem(literal) as string),
    );

    expect(offenders.map(({ file, literal }) => `${literal} (${file})`)).toEqual([]);
  });
});
