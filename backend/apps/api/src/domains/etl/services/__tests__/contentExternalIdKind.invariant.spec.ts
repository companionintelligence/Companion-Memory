import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import * as ts from 'typescript';

/**
 * Every ETL connector transform that writes `ci.content.external_id` must also
 * write `external_id_kind`.
 *
 * This is the guard that keeps defect F22 from coming back. The column was
 * added with a backfill migration that classified rows by SOURCE SYSTEM, and
 * every write path that did not stamp the column left its rows to be guessed at
 * by the next such migration. A per-transform behaviour test would need an HTTP
 * client, a connection record and an event service for each of ~19 call sites;
 * this asserts the same invariant over the source itself, so a NEW transform
 * that forgets the stamp fails here rather than silently producing rows that
 * claim to be `ci.files` ids.
 *
 * The rule, deliberately narrow: inside a file that writes content
 * (`contentService.create` / `.createMany` / `.update`), any object literal
 * carrying an `external_id` property must also carry `external_id_kind` —
 * unless it is an argument to a `.search(...)` call, where `external_id` is a
 * lookup key rather than a value being persisted.
 */
const ETL_ROOT = join(__dirname, '..');

/** A file that persists a content row, directly or through the Spotify helper. */
const CONTENT_WRITER = /contentService\.(create|createMany|update)\(|upsertContentForEvent\(/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') {
        collectSourceFiles(full, out);
      }

      continue;
    }

    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }

  return out;
}

/** Property names on an object literal, ignoring spreads and computed keys. */
function propertyNames(node: ts.ObjectLiteralExpression): string[] {
  return node.properties
    .map((prop) => prop.name)
    .filter(
      (name): name is ts.Identifier | ts.StringLiteral =>
        name != null && (ts.isIdentifier(name) || ts.isStringLiteral(name)),
    )
    .map((name) => name.text);
}

/** True when this literal is (directly) an argument of a `.search(...)` call. */
function isSearchArgument(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  if (parent == null || !ts.isCallExpression(parent)) {
    return false;
  }

  const callee = parent.expression;

  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'search';
}

interface Offender {
  file: string;
  line: number;
  properties: string[];
}

function findUnstampedContentLiterals(): Offender[] {
  const offenders: Offender[] = [];

  for (const file of collectSourceFiles(ETL_ROOT)) {
    const text = readFileSync(file, 'utf8');
    // Only files that actually persist a content row are in scope. A Person's
    // `properties` bag also carries an `external_id` key (see
    // Steam/transform/TransformFriends.ts) and has nothing to do with this
    // column. The Spotify transforms write through `upsertContentForEvent`
    // (Spotify/transform/linkContentToEvent.ts) rather than calling
    // `contentService.create` themselves, so that counts as writing too.
    if (!CONTENT_WRITER.test(text)) {
      continue;
    }

    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = propertyNames(node);
        if (names.includes('external_id') && !names.includes('external_id_kind') && !isSearchArgument(node)) {
          offenders.push({
            file: file.slice(file.indexOf('src/')),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            properties: names,
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return offenders;
}

describe('ETL content writers stamp external_id_kind', () => {
  it('finds no content-writing object literal that sets external_id without external_id_kind', () => {
    expect(findUnstampedContentLiterals()).toEqual([]);
  });

  it('actually inspects the transforms — a scan that matched nothing would pass vacuously', () => {
    // Sanity check on the scanner itself: the files it is meant to cover must
    // be reachable from ETL_ROOT and must contain the stamp.
    const covered = collectSourceFiles(ETL_ROOT).filter((file) =>
      CONTENT_WRITER.test(readFileSync(file, 'utf8')),
    );

    expect(covered.length).toBeGreaterThanOrEqual(15);

    // The Spotify helper forwards a DTO its caller built and never names
    // `external_id` itself, so it has nothing to stamp.
    const writesExternalId = covered.filter((file) => readFileSync(file, 'utf8').includes('external_id'));
    expect(writesExternalId.length).toBeGreaterThanOrEqual(15);

    const stamping = writesExternalId.filter((file) =>
      readFileSync(file, 'utf8').includes('SOURCE_NATIVE_EXTERNAL_ID_KIND'),
    );
    expect(stamping.length).toBe(writesExternalId.length);
  });
});
