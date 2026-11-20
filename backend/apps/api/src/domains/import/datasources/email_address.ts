/*
 * Address-list headers (From, To, Cc, Bcc), read the way RFC 5322 writes them.
 *
 * A display name may hold a comma inside quotes: Outlook and Exchange write
 * people as "Last, First" <addr>. Splitting such a header on every comma cut
 * each of those names in two, so "Quillfeather, Zephyrine" became a contact
 * named `"Quillfeather` and another named `Zephyrine"`. These helpers split
 * only on the commas BETWEEN mailboxes.
 *
 * Linear scans, never a regex over the whole header: a single pathological
 * 120k-character address header once took a backtracking regex 8.5 s, and a
 * longer one hung a whole mbox import.
 */
import { decodeHeaderField } from './email_mime';

/** One mailbox of an address header. */
export interface Mailbox {
  /** The display name, unquoted, when the mailbox has one. */
  name?: string;
  email?: string;
}

/**
 * Split an address-list header into the text of each mailbox, on the commas
 * outside a quoted string, an `<…>` address and a `(…)` comment. A list with
 * no quotes, brackets or parentheses splits exactly as it would on every
 * comma, and so does whatever follows a quote, bracket or parenthesis that is
 * never closed (a name like `I <3 cats` in a chat's recipient list). Group
 * syntax goes: `undisclosed-recipients:;` names nobody, and `Team: a@x, b@y;`
 * is the two addresses. Empty entries are dropped and each entry is trimmed.
 */
export function splitAddressList(header: string): string[] {
  return splitMailboxes(header).map(withoutGroup).filter(Boolean);
}

/** {@link splitAddressList} before the group syntax is taken off. */
function splitMailboxes(header: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inQuote = false;
  let inAngle = false;
  let comment = 0;

  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (c === '\\' && (inQuote || comment > 0)) {
      i++; // a quoted-pair: the next character is literal
    } else if (inQuote) {
      inQuote = c !== '"';
    } else if (c === '"') {
      inQuote = true;
    } else if (c === '(') {
      comment++;
    } else if (c === ')' && comment > 0) {
      comment--;
    } else if (comment > 0) {
      // inside a comment
    } else if (c === '<') {
      inAngle = true;
    } else if (c === '>') {
      inAngle = false;
    } else if (c === ',' && !inAngle) {
      out.push(header.slice(start, i));
      start = i + 1;
    }
  }

  const rest = header.slice(start);
  out.push(...(inQuote || inAngle || comment > 0 ? rest.split(',') : [rest]));

  return out.map((part) => part.trim()).filter(Boolean);
}

/**
 * One entry without the RFC 5322 group syntax around it: the `Label:` before a
 * group's first mailbox and the `;` after its last, and nothing at all for an
 * empty group. Only taken off when what is left is an address or nothing, so a
 * name with a colon in it ("Mom: Jane" in a chat's recipient list) stays whole.
 */
function withoutGroup(part: string): string {
  const label = /^[^"<>@(),:;]*:/.exec(part);
  let rest = label ? part.slice(label[0].length).trim() : part;
  const closes = rest.endsWith(';');
  if (closes) {
    rest = rest.slice(0, -1).trim();
  }

  if (!rest) {
    return label && closes ? '' : part;
  }

  return (label || closes) && rest.includes('@') ? rest : part;
}

/** A quoted display name without its quotes and quoted-pair backslashes. */
function unquote(name: string): string {
  const quoted = name.length >= 2 && name.startsWith('"') && name.endsWith('"');

  return (quoted ? name.slice(1, -1).replace(/\\(.)/g, '$1') : name.replace(/^"|"$/g, '')).trim();
}

/** One mailbox: `Name <addr>`, `"Last, First" <addr>`, `addr (Name)` or a bare `addr`. */
export function parseEmailAddress(raw: string): Mailbox {
  const lt = raw.indexOf('<');
  if (lt !== -1) {
    const gt = raw.indexOf('>', lt + 1);
    if (gt !== -1) {
      const email = raw.slice(lt + 1, gt).trim();
      const name = unquote(raw.slice(0, lt).trim()) || undefined;

      return { name, email };
    }
  }

  if (/^[^@\s]+@[^@\s]+$/.test(raw)) {
    return { email: raw.trim() };
  }

  // The older `addr (Name)` form: the comment is the name.
  const paren = raw.indexOf('(');
  const end = raw.trimEnd();
  if (paren > 0 && end.endsWith(')')) {
    const email = raw.slice(0, paren).trim();
    if (/^[^@\s]+@[^@\s]+$/.test(email)) {
      const name = end.slice(paren + 1, -1).trim();

      return name ? { name, email } : { email };
    }
  }

  return { name: raw };
}

/**
 * Decode the RFC 2047 encoded words of an address-list header without losing
 * where one mailbox ends. The list is split first, while every comma in it is
 * a real one, and a decoded name that now holds a comma or a quote is quoted,
 * so `=?UTF-8?Q?M=C3=BCller=2C_Hans?= <h@x>` reads `"Müller, Hans" <h@x>` and
 * still splits into one mailbox. A header with no encoded word is returned
 * unchanged.
 */
export function decodeAddressList(raw: string): string {
  if (!raw.includes('=?')) {
    return raw;
  }

  return splitMailboxes(raw)
    .map((part) => {
      const decoded = decodeHeaderField(part);
      const { name, email } = parseEmailAddress(decoded);
      const quoted = decoded.startsWith('"');

      return name && email && !quoted && /[",]/.test(name)
        ? `"${name.replace(/(["\\])/g, '\\$1')}" <${email}>`
        : decoded;
    })
    .join(', ');
}

/** Address-list headers, whose values decodeAddressList reads. */
export const ADDRESS_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'sender']);
