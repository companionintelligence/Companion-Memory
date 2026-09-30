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
 * The `tel:` link for a phone the Details card shows. It dials what the link
 * shows — the number as typed (`rawValue`) when there is one, else `value`.
 *
 * Not `value` first: an indexed number's `value` is its join key, and
 * `normalizePhone` (the backend's `domains/graph/utils/normalizeIdentifier.ts`)
 * keeps only the LAST TEN digits, so the country code a number was written with
 * is gone. `+44 20 7946 0958` keys as `2079460958`, which a North American phone
 * dials as a Maine number — the example `memory/utils/phoneIdentity.ts` gives.
 *
 * - A `+` is kept, and so is a written `00` or `011`, as typed rather than
 *   rewritten as `+`: which of them is an international access code depends on
 *   where the call is made from, and `011` also begins Johannesburg and Delhi
 *   numbers dialled at home. Rewritten, it would become a country code nobody
 *   wrote.
 * - No country code is added. A number written without one is dialled as the
 *   local number it was typed as: `(415) 555-0100` is not assumed to be North
 *   American, and `020 7946 0958` keeps its trunk zero.
 * - `value` is the fallback when there is no typed form, or the typed form is
 *   not one number.
 */
export function phoneHref(phone: { value: string; rawValue?: string | null }): string {
  const dialled = dialDigits(phone.rawValue?.trim() || phone.value);

  return `tel:${isOneNumber(dialled) ? dialled : phone.value}`;
}
