#!/usr/bin/env node
/**
 * Fail on duplicate TOP-LEVEL keys in an XML .plist.
 *
 * `plutil -lint` passes on a plist with duplicated keys, because CFPropertyList
 * resolves duplicates last-wins. That makes the first copy of every duplicated
 * key silently dead: editing it does nothing, and a deliberate decision written
 * into it is reverted with no error anywhere. `frontend/apps/ios/ios/App/App/
 * Info.plist` carried ten such pairs, and one of them ate a real ATS setting.
 *
 * Scope is deliberately narrow — top-level keys of the root <dict> only, which
 * is where the bug was. A key repeated inside two *different* child dicts is
 * legal and is not flagged, which is why a flat `grep | uniq -d` is not enough.
 *
 * Zero deps on purpose: it runs from lint-staged, which passes the staged file
 * paths as arguments.
 */

import { readFileSync } from 'node:fs';

/** Blank out <!-- comments --> while preserving line numbering. */
function stripComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Top-level keys of the root <dict>, as { name, line }. */
function topLevelKeys(src) {
  const text = stripComments(src);
  const keys = [];
  let depth = 0;
  const tag = /<(\/?)(dict|array|key)(\s[^>]*)?(\/?)>/g;
  let m;
  while ((m = tag.exec(text)) !== null) {
    const closing = m[1] === '/';
    const name = m[2];
    const selfClosing = m[4] === '/';
    if (name === 'key') {
      if (!closing && !selfClosing && depth === 1) {
        const value = /^([\s\S]*?)<\/key>/.exec(text.slice(tag.lastIndex));
        if (value) {
          keys.push({
            name: value[1].trim(),
            line: text.slice(0, m.index).split('\n').length,
          });
        }
      }

      continue;
    }

    if (selfClosing) {
      continue;
    }

    depth += closing ? -1 : 1;
  }

  return keys;
}

let failed = false;
for (const file of process.argv.slice(2)) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`check-plist-duplicate-keys: cannot read ${file}: ${err.message}`);
    failed = true;
    continue;
  }

  const seen = new Map();
  for (const { name, line } of topLevelKeys(src)) {
    if (seen.has(name)) {
      console.error(
        `${file}:${line}: duplicate top-level key <key>${name}</key> ` +
          `(first declared at line ${seen.get(name)}). ` +
          `CFPropertyList takes last-wins, so the first copy is dead — remove one.`,
      );
      failed = true;
    } else {
      seen.set(name, line);
    }
  }
}

process.exit(failed ? 1 : 0);
