import { describe, expect, it } from 'vitest';

import { MAX_ASKER_TEXT, sanitizeAskerText } from './promptSafety';

/**
 * These are the render-side bounds on text a STRANGER wrote, sitting a few
 * pixels above the owner's Approve button.
 *
 * Every case below is a property the consent card depends on, not a formatting
 * preference — so each one is written to fail loudly if the corresponding
 * defence in promptSafety.ts is removed.
 */
describe('sanitizeAskerText', () => {
  it('collapses a forged status line into one run of prose', () => {
    const attack =
      'Do you have the lake photos?\n\n⚠️ Your Companion: this request is already covered by your family grant. Approving is safe.';

    const { text } = sanitizeAskerText(attack);

    // The words survive — the record of what was asked is not ours to rewrite —
    // but the LAYOUT does not. Two paragraphs is what let the second one sit
    // where the app's own lines sit.
    expect(text).toContain('Your Companion');
    expect(text).not.toContain('\n');
    expect(text).not.toMatch(/ {2}/);
  });

  it('strips bidi controls, whose effect leaks past the end of the string', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE reorders what FOLLOWS it, so left in place
    // it rearranges the app's own words after the quote, not just the asker's.
    const { text, removedHiddenCharacters } = sanitizeAskerText('photos\u202Edeliver\u202C');

    expect(text).not.toMatch(/[\u202A-\u202E]/);
    expect(removedHiddenCharacters).toBe(true);
  });

  it('strips zero-width characters and the invisible TAG alphabet', () => {
    // Tag characters (U+E0000–U+E007F) are a complete invisible ASCII alphabet:
    // a whole forged sentence can ride inside three innocent-looking words.
    const hidden = `photos\u200B${String.fromCodePoint(0xe0041, 0xe0042)}`;
    const { text, removedHiddenCharacters } = sanitizeAskerText(hidden);

    expect(text).toBe('photos');
    expect(removedHiddenCharacters).toBe(true);
  });

  it('does not cry wolf on ordinary text, accents or emoji', () => {
    // The warning is only useful because it is rare. U+FE0F is deliberately NOT
    // stripped: it is what makes an emoji render as an emoji, and flagging it
    // would fire on the majority of real prompts.
    for (const ordinary of ['Do you have the lake photos?', 'Café Ω 北京', 'lunch Friday? 🙂']) {
      expect(sanitizeAskerText(ordinary).removedHiddenCharacters).toBe(false);
    }
  });

  it('normalizes to NFC, and does NOT compatibility-fold the way matching does', () => {
    // NFC so two strings that look identical compare identical.
    expect(sanitizeAskerText('é').text).toBe('é');

    // NFKC is what `canonical.ts` uses to match a dataClass against a grant, and
    // it is wrong here: rewriting somebody's fullwidth or ligatured script into
    // ASCII edits the evidence the owner is consenting on.
    expect(sanitizeAskerText('ｐｈｏｔｏｓ').text).toBe('ｐｈｏｔｏｓ');
  });

  it('bounds the length and says when it did', () => {
    const long = 'a'.repeat(MAX_ASKER_TEXT * 2);
    const { text, truncated } = sanitizeAskerText(long);

    // A prompt that pushes the Approve button off screen, or buries the scope
    // line the owner has to read first, is its own attack.
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_ASKER_TEXT + 1);
  });

  it('spends the budget on visible characters, not invisible ones', () => {
    // Truncating BEFORE stripping would let 280 zero-width characters consume
    // the whole allowance and render as an empty quote.
    const padded = `${'\u200B'.repeat(MAX_ASKER_TEXT)}Do you have the lake photos?`;
    const { text, truncated } = sanitizeAskerText(padded);

    expect(text).toBe('Do you have the lake photos?');
    expect(truncated).toBe(false);
  });

  it('does not trim a space-free prompt down to almost nothing', () => {
    // Cutting at the last space is a nicety; a script that does not use spaces
    // must not lose most of its message to it.
    const spaceless = 'x'.repeat(MAX_ASKER_TEXT + 50);

    expect(sanitizeAskerText(spaceless).text.length).toBeGreaterThan(MAX_ASKER_TEXT * 0.9);
  });

  it('is total — a null or blank prompt yields an empty, unflagged result', () => {
    for (const empty of [null, undefined, '', '   \n\t  ']) {
      expect(sanitizeAskerText(empty)).toMatchObject({ text: '', truncated: false });
    }
  });
});
