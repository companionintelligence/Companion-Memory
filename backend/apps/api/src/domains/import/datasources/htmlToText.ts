/**
 * Shared HTML/ENML → plain-text flattening for import datasources.
 *
 * Five datasources (facebook, instagram, mastodon, evernote, email_mime) each
 * hand-rolled their own regex tag-stripper. Regex tag-stripping cannot tell a
 * `<script>`/`<style>` block's CONTENTS from real text, and each copy decoded
 * only the handful of named entities its author happened to type in — a real
 * Facebook export leaked thumbnail/reaction markup into post/message text
 * this way (see the facebook.ts extractEntryBodyText history), and the same
 * regex-strip shape sits in four more files waiting to do it again.
 *
 * This uses htmlparser2 — a real streaming tokenizer (the engine under
 * cheerio) — so tag nesting and entity decoding (the full HTML5 named-entity
 * table, not a hand-picked six) are correct by construction instead of by
 * regex luck.
 */
import { Parser } from 'htmlparser2';

const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
]);

// Soft hyphen (U+00AD), zero-width space/joiners (U+200B-U+200D), word joiner
// (U+2060), BOM (U+FEFF): invisible once rendered, but they land in the text
// stream and would otherwise break word boundaries and pad length checks
// downstream. Written as \u escapes, not literal characters, so the source
// file itself doesn't carry invisible bytes.
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Flatten an HTML (or ENML, which is an XHTML subset) fragment to readable
 * plain text.
 *
 *   - `<script>`/`<style>`/`<head>`/`<title>`/`<noscript>`/`<template>` are
 *     removed WITH their contents.
 *   - `<br>` and block-level closing tags (p, div, li, h1-6, table rows, …)
 *     become a newline; `</td>`/`</th>` become a tab, so a receipt's item and
 *     price stay on one line instead of running together.
 *   - Every other tag is dropped, entities are decoded in full, and runs of
 *     blank lines collapse.
 *
 * Not a DOM: no querying, no attribute access — output is a single string,
 * which is all every current caller needs. A caller that needs structure
 * (links, image counts, …) is a reason to extend this, not to hand-roll a
 * parallel stripper.
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) {
    return '';
  }

  let out = '';
  let pendingNewlines = 0;
  let pendingTab = false;
  let pendingSpace = false;
  let skipDepth = 0;

  // htmlparser2 fires one `ontext` call per decoded entity (an entity-laden
  // run of "a &amp; b" arrives as five separate calls, not one), so a plain
  // "did the CURRENT chunk start with a space" check misses whitespace that
  // fell in the PREVIOUS or an intervening whitespace-only chunk. `pendingSpace`
  // survives across chunks/tags the same way `pendingNewlines` does, and a
  // newline always wins over a bare space when both are pending.
  function flush(): void {
    if (pendingNewlines > 0) {
      if (out) {
        out += '\n'.repeat(Math.min(pendingNewlines, 2));
      }
    } else if (pendingTab) {
      if (out && !out.endsWith('\n')) {
        out += '\t';
      }
    } else if (pendingSpace) {
      if (out && !out.endsWith('\n')) {
        out += ' ';
      }
    }

    pendingNewlines = 0;
    pendingTab = false;
    pendingSpace = false;
  }

  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP_TAGS.has(name)) {
          skipDepth++;

          return;
        }

        if (skipDepth > 0) {
          return;
        }

        if (name === 'br' || BLOCK_TAGS.has(name)) {
          // Additive, not a plain flag: a real blank line between two block
          // elements (an opening tag closely followed by another, or a run of
          // <br><br>) must survive as TWO newlines after collapsing, matching
          // the boundary this replaced (which newlined the closing tag AND the
          // next opening tag as two independent substitutions).
          pendingNewlines = Math.min(pendingNewlines + 1, 2);
        }
      },
      onclosetag(name) {
        if (SKIP_TAGS.has(name)) {
          if (skipDepth > 0) {
            skipDepth--;
          }

          return;
        }

        if (skipDepth > 0) {
          return;
        }

        if (name === 'td' || name === 'th') {
          pendingTab = true;

          return;
        }

        if (BLOCK_TAGS.has(name)) {
          pendingNewlines = Math.min(pendingNewlines + 1, 2);
        }
      },
      ontext(data) {
        if (skipDepth > 0) {
          return;
        }

        const collapsed = data.replace(INVISIBLE, '').replace(/\s+/g, ' ');
        const trimmed = collapsed.trim();
        if (!trimmed) {
          // A whitespace-only chunk between two inline runs ("foo</span> <span>bar")
          // still separates them once flushed.
          if (collapsed) {
            pendingSpace = true;
          }

          return;
        }

        if (collapsed.startsWith(' ')) {
          pendingSpace = true;
        }

        flush();
        out += trimmed;
        if (collapsed.endsWith(' ')) {
          pendingSpace = true;
        }
      },
    },
    { decodeEntities: true },
  );

  parser.write(html);
  parser.end();

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}
