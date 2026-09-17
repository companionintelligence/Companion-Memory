#!/usr/bin/env node
//
// Rejects XML comments that are not well-formed, for the files named in argv.
//
// WHY THIS EXISTS, specifically. An XML comment may not contain two consecutive
// hyphens, and may not end with one. Canon design tokens are CSS custom
// properties, so every one of their real names STARTS with exactly that
// sequence — which makes "paste the token name into a comment" both the natural
// thing to write and a syntax error. That is not hypothetical: #2686 landed
// `frontend/apps/android/.../res/values/colors.xml` naming the canon tokens in
// a comment, and `main` could not build the Android app at all until it was
// fixed. aapt2 reports it as
//
//     colors.xml:5:82: Error: The string [two hyphens] is not permitted within comments.
//
// but only from `:app:mergeDebugResources`, i.e. two minutes into a full Gradle
// build, on a lane that is `workflow_dispatch`-only. This check is milliseconds
// and runs on every commit that touches a staged Android XML file, via
// `.lintstagedrc` — not from a GitHub Actions workflow. It briefly ran from
// `pr-gate.yml`'s `Mobile native guards` job instead; that file was deleted
// 2026-09-17 (cost — see docs/CI.md), so lint-staged is this check's only home
// now, same as its siblings `check-plist-duplicate-keys.mjs` and
// `check-capacitor-native-sync.mjs`.
//
// Dependency-free on purpose, like its siblings in this directory: `node:22`
// with no install step, and no XML library — Node ships no XML parser, and
// pulling one in to check a lexical rule would be the expensive way to be less
// certain. It reads ONLY the comment syntax; it is not a well-formedness check
// for the document as a whole.
//
// CALL SHAPE: paths in argv, like scripts/check-plist-duplicate-keys.mjs. With
// no arguments it exits 0 having checked nothing, so any caller must assert its
// own file list is non-empty — lint-staged does this itself, by only invoking
// a matcher's command when at least one staged file matched its glob.

import { readFileSync } from 'node:fs';

const OPEN = '<!--';
const CLOSE = '-->';

/** Line/column (both 1-based) of a byte offset, for an editor-clickable report. */
function positionOf(text, index) {
  const upTo = text.slice(0, index);
  const line = upTo.split('\n').length;
  const column = index - (upTo.lastIndexOf('\n') + 1) + 1;

  return { line, column };
}

/**
 * Every problem in one file's comments.
 *
 * Scans lexically rather than by structure: a `<!--` inside a CDATA section or
 * an attribute value is not really a comment, and this will still look at it.
 * That is the safe direction to be wrong in for a guard — the false positive is
 * visible and arguable, a false negative is another unbuildable `main`.
 */
function findCommentProblems(text) {
  const problems = [];
  let cursor = 0;

  for (;;) {
    const start = text.indexOf(OPEN, cursor);

    if (start === -1) {
      break;
    }

    const contentStart = start + OPEN.length;
    const end = text.indexOf(CLOSE, contentStart);

    if (end === -1) {
      problems.push({ ...positionOf(text, start), message: 'unterminated comment' });
      break;
    }

    const content = text.slice(contentStart, end);
    const doubleHyphen = content.indexOf('--');

    if (doubleHyphen !== -1) {
      problems.push({
        ...positionOf(text, contentStart + doubleHyphen),
        message: 'comment contains two consecutive hyphens',
      });
    } else if (content.endsWith('-')) {
      // `<!-- x --->`: the comment closes at the FIRST `-->`, leaving content
      // that ends in a hyphen. Illegal for the same reason and easy to type.
      problems.push({
        ...positionOf(text, end - 1),
        message: 'comment content ends with a hyphen',
      });
    }

    cursor = end + CLOSE.length;
  }

  return problems;
}

let failed = false;

for (const file of process.argv.slice(2)) {
  let text;

  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`::error file=${file}::could not read: ${err.message}`);
    failed = true;
    continue;
  }

  for (const { line, column, message } of findCommentProblems(text)) {
    console.error(`::error file=${file},line=${line},col=${column}::${message}`);
    failed = true;
  }
}

if (failed) {
  console.error(
    '\nAn XML comment may not contain two consecutive hyphens or end with one.\n' +
      'If you are naming a canon design token, write its name without the leading\n' +
      'dashes and say so in prose — see the comment in\n' +
      'frontend/apps/android/android/app/src/main/res/values/colors.xml.',
  );
}

process.exit(failed ? 1 : 0);
