/**
 * `PHONE_EXTENSION_PATTERN` from the backend's
 * `domains/graph/utils/normalizeIdentifier.ts`, restated verbatim —
 * `phoneHref.node.test.ts` fails if the two differ. The server refuses a number
 * as carrying an extension by this pattern and then shows it as typed, so the
 * card has to find the same extension in it.
 */
export const PHONE_EXTENSION_PATTERN = String.raw`[;,#]|(?:^|[^a-z])(?:ext(?:ension|n)?|x)\.?\s*:?\s*\d|\d\s*[pw]\s*\d`;

const PHONE_EXTENSION = new RegExp(PHONE_EXTENSION_PATTERN, 'i');

/** E.164's cap on the digits of one number, its country code included. */
const E164_MAX_DIGITS = 15;

/**
 * Digits, led by `+` when the number was written with one.
 *
 * A `(0)` behind a country code is the trunk prefix that notation says to leave
 * out when the code is dialled: `+44 (0)20 7946 0958` is `+442079460958`. With
 * nothing in front of it — `(0)20 7946 0958` — it is the zero dialled at home,
 * and stays.
 */
function dialDigits(text: string): string {
  const dialled = text.replace(/(\d\D*?)\(\s*0\s*\)/, '$1');
  const digits = dialled.replace(/\D/g, '');

  return dialled.replace(/[^\d+]/g, '').startsWith('+') ? `+${digits}` : digits;
}

/**
 * Whether a dial string is one number: it has digits, and no more of them than
 * E.164 allows once a written `+`, `00` or `011` is set aside. Two numbers typed
 * into one field have more, and run together they dial neither.
 */
function isOneNumber(dialled: string): boolean {
  const digits = dialled.replace(/^(?:\+|00|011)/, '');

  return digits !== '' && digits.length <= E164_MAX_DIGITS;
}

/**
 * `tel:<line>;ext=<extension>` when `text` carries an extension the server
 * would refuse as a join key, or null when it does not.
 */
function extensionHref(text: string): string | null {
  const marker = PHONE_EXTENSION.exec(text);

  if (marker == null) {
    return null;
  }

  // The match starts AT the marker (`;` `,` `#`, or an `x`/`ext` opening the
  // string) or one character before it: the non-letter in front of an
  // `x`/`ext`, or the digit in front of a `p`/`w`.
  const start = marker.index + (/^[a-z;,#]/i.test(marker[0]) ? 0 : 1);
  const line = dialDigits(text.slice(0, start));
  const extension = text.slice(start).replace(/\D/g, '');

  if (line.replace('+', '') === '' || extension === '') {
    return null;
  }

  return `tel:${line};ext=${extension}`;
}

/**
 * The `tel:` link for a phone the Details card shows. It dials what the link
 * shows — the number as typed (`rawValue`) when there is one, else `value`.
 *
 * Not `value` first: an indexed number's `value` is its join key, and
 * `normalizePhone` keeps only the LAST TEN digits, so the country code a
 * number was written with is gone. A number carrying an extension has no key,
 * so the server shows the typed string as `value`, and that string is split
 * into `tel:<line>;ext=<ext>` rather than run together.
 *
 * - A `+` is kept, and so is a written `00` or `011`, as typed rather than
 *   rewritten as `+`.
 * - No country code is added.
 * - `value` is the fallback when there is no typed form, or the typed form is
 *   not one number.
 */
export function phoneHref(phone: { value: string; rawValue?: string | null }): string {
  const typed = phone.rawValue?.trim() || phone.value;
  const split = extensionHref(typed);

  if (split != null) {
    return split;
  }

  const dialled = dialDigits(typed);

  return `tel:${isOneNumber(dialled) ? dialled : phone.value}`;
}
