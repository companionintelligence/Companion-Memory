"""
Deterministic redaction for text that becomes tone-adapter training data.

``Redactor.redact(text)`` returns ``(redacted_text, counts)``. ``counts`` maps each
category that matched to its number of replacements, and categories with no match are
left out. The output depends only on the input and the configured names, so the same
input always gives the same output, and redacting a second time changes nothing.

Nothing in the runtime calls this module yet. Its only caller is
``persona_extractor.build_tone_examples``, which is off unless
``HBPE_TONE_EXAMPLES_ENABLED`` is set.

Before any rule runs, the text is put into Unicode NFKC form, and Unicode decimal digits
are written as ASCII digits, so full-width and Arabic-Indic digits are read as digits.

The rules run in the order below, and the whole set repeats until a pass changes
nothing. Names run first, so a denied name is replaced before a query or a number next
to it is removed.

- ``name``: caller-supplied names, matched case-insensitively as whole words, become
  ``[NAME]``. A name is left alone when it is followed by ``@`` and a dotted domain, or by
  ``.`` and a lowercase letter or digit, and when it follows ``@`` or ``.`` after a word,
  so an address or a host name is not broken up. A name followed by a hyphen is redacted
  even inside a host name, so ``sarah-co.example.com`` becomes ``[NAME]-co.example.com``.
  A name written in a script without spaces, such as Chinese or Japanese, is matched
  wherever it occurs, and such a script beside a spaced name still leaves it a whole word,
  so ``Chat Sarahさん`` becomes ``Chat [NAME]さん``. Both the precomposed and the
  decomposed spelling of a name match, a German sharp s also matches ``ss``, and a
  straight apostrophe matches a curly one.
- ``url``: a URL with a query string or fragment, with credentials (``user:pass@``), or
  with a token-like path segment. A URL is text that starts with a scheme, such as
  ``https://`` or ``postgres://``, or with ``www.``, or with a host, optionally followed
  by a port, and then a path, query or fragment, such as ``example.com/pay?x=1``. The
  scheme, host and path are kept. The query, the fragment and the credentials are dropped.
  A path segment of at least 20 letters, digits or underscores, with both a letter and a
  digit, becomes ``[TOKEN]``. A query value of 20 or more characters is always dropped.
  A shorter value that starts with a letter is dropped too, so a one-time code followed by
  words, as in ``?code=8f3a2c (valid 15 min)``, goes with it, and so does
  ``?ref=40K4LpE5h5M9``. The exception is a number that follows the value straight away:
  two or more digit groups, five or more digits, ``+``, ``(`` before a digit, or ``[``. Then
  the value is kept, so the number after it is not cut into. A value that starts with a
  digit is dropped when it mixes letters and digits and is at least six characters long, as
  in ``?9Xk2mQ7p``. A short ``key=digits`` value followed by a capitalised word is kept, so
  ``?q=221 Baker Street`` keeps its house number for the address rule. A URL with none of
  these is left alone.
- ``email``: an address with a dotted domain, or with an IPv4 domain, such as
  ``sarah@example.com``, becomes ``[EMAIL]``, and a path or query directly after it goes
  with it. Letters from any script count, so ``josé@example.com`` is caught. An apostrophe
  or an exclamation mark may sit inside the local part, but only after a letter, so
  ``o'brien@example.com`` is caught whole, and a digit glued before an address with either
  mark is not swallowed.
- ``iban``: an IBAN of a country whose registered length is listed in this module, taken
  at that length, becomes ``[IBAN]`` when it passes the mod-97 check, even when it is glued
  to letters. Its groups may be separated by up to two spaces or hyphens, so
  ``GB82-WEST-1234-5698-7654-32`` is caught. An IBAN of a country that is not listed is
  kept, since its length is not known, and a mod-97 check passes by chance about one time
  in a hundred for any run of letters and digits.
- ``phone``: numbers with a leading ``+`` or ``00``, North American numbers, and UK and
  French style national numbers become ``[PHONE]``. A national number that starts with 0
  and is written in groups, such as ``07700 900 123`` or ``07700900 123``, is read as a
  phone number when it has 10 or 11 digits, but a zero that follows a digit and a comma or
  dot, as in ``1,000,000``, does not start one. A match must carry 8 to 15 digits. A number
  may follow a letter, so ``call07700900123`` is caught.
- ``card``: the longest run of whole digit groups that passes the Luhn check becomes
  ``[CARD]``. Groups are separated by one to three spaces, tabs or non-breaking spaces, or
  by a hyphen. A card may also be written as four groups of four digits joined by dots.
  Separated dates and times are masked before the search, so a card never runs into one.
  Digits after the card, as in ``4111 1111 1111 1111 123``, are kept, and a card with its
  security code glued on, as in ``4111111111111111123``, is still found. A 14-digit
  ``YYYYMMDDhhmmss`` stamp is not treated as a card.
- ``address``: a house number, one to three capitalised words and a street suffix
  (Street, Road, Avenue and so on) become ``[ADDRESS]``. The house number may carry a
  letter or a second number, as in ``221B``, ``221-B`` or ``12-14``, and a comma may follow
  it, as in ``10, Downing Street``. A capitalised word may begin with an accented capital,
  such as ``Å``. A number followed by a storage or speed unit, such as ``2 TB`` or
  ``500 GB``, is not a house number.

Names come in two lists. ``deny_names`` are redacted wherever they appear, including
where two denied names overlap, except inside an address or a host name as described
above. ``allow_names`` are phrases that stay as written when a denied name sits wholly
inside them: ``"Central Park"`` keeps ``"Park"`` when ``"Park"`` is denied, and
``"I will"`` keeps ``"Will"`` when ``"Will"`` is denied. A denied name that only overlaps
an allowed phrase is still redacted. With ``"Ann"`` allowed and ``"Ann Marie"`` denied,
``"Ann Marie"`` becomes ``[NAME]``. A name that is on both lists is rejected, because
the intent is unclear.

Dates and times in the usual separated forms are never redacted, and neither is a
number on its own with fewer than 8 digits. A bare run of 10 digits whose first and
fourth digits are 2 to 9 is read as a phone number, so a compact ``YYYYMMDDhh`` stamp can
be redacted.

Known gaps, some by design: a name directly after a dot, as in ``Hi.Sarah``, or before a
lowercase word after a dot, as in ``Sarah.pdf``, is not redacted, because a dot after a word
marks a domain or a file name. 7-digit local phone numbers, including one that follows a
longer number, lowercase street addresses, postcodes, and names that are not listed. A name
inside a host label, such as ``sarah.example.com``, is not redacted. Digits glued straight to
an address with no space, such as ``4111 1111 1111 1111sarah@example.com``, have the glued
group taken into the address, so the rest of the number stays. A product name such as
``2 Google Drive`` can match the address rule. The userinfo of a URL whose password contains
a slash is not stripped. A card written with slashes or with line breaks is not recognised,
and neither is a quoted local part such as ``"sarah"@example.com``. A phone number written
with a space after the plus sign, such as ``+ 44 20 7946 0958``, or with a bracketed zero,
such as ``(0)20 7946 0958``, is not matched, and neither is a national number without a plus
sign or a 00 prefix outside North America, the UK and France. A UUID in a path is not
treated as a token. A short value followed by two digit groups in a query is kept, as in
``?ref=abc 12 34``, so a short token there is not removed. A house number glued to a word,
as in ``Flat221 Baker Street``, is not matched. An unseparated North American number whose
exchange starts with 0 or 1, such as ``5551234567``, is not read as a phone number, though
the separated form ``555-123-4567`` is. A query made only of digits and shorter than 20
characters, such as ``?12345``, is kept. An IBAN of an unlisted country is kept, as
described above. A secret written outside a URL, such as ``api_key=sk_live_...``, is not
redacted, and neither are bank sort codes or national insurance numbers.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Iterable
from datetime import datetime

CATEGORIES: tuple[str, ...] = (
    "url",
    "email",
    "iban",
    "phone",
    "card",
    "address",
    "name",
)

_DIGITS = "0123456789"
# Placeholder tokens written by the rules below. The name rule never touches them.
_TOKEN_WORDS = ("EMAIL", "PHONE", "CARD", "IBAN", "ADDRESS", "NAME", "TOKEN")
_STREET_SUFFIXES = (
    "Street",
    "St",
    "Road",
    "Rd",
    "Avenue",
    "Ave",
    "Boulevard",
    "Blvd",
    "Lane",
    "Ln",
    "Drive",
    "Dr",
    "Court",
    "Ct",
    "Place",
    "Pl",
    "Terrace",
    "Ter",
    "Close",
    "Cl",
    "Crescent",
    "Cres",
    "Square",
    "Sq",
    "Parkway",
    "Pkwy",
    "Highway",
    "Hwy",
    "Gardens",
    "Grove",
    "Way",
    "Mews",
    "Row",
    "Walk",
    "Rise",
    "Hill",
    "Gate",
    "Circle",
    "Trail",
    "Plaza",
    "Path",
    "Loop",
    "Str",
)
_SUFFIX_ALTERNATION = "|".join(
    re.escape(suffix) for suffix in sorted(_STREET_SUFFIXES, key=len, reverse=True)
)

# The path of a URL. It stops at "?" and "#", which start the query and the fragment.
_URL_PATH = r"(?:/[^\s<>\"'?#]*)?"
# The query or fragment of a URL, which is dropped with the URL. A value of 20 or more
# characters, with an optional "key=" in front, is always dropped. A shorter value is kept
# only when a phone number, a card or a placeholder follows it straight away, since
# dropping it there would cut into that number. A value that ends in a digit and is followed
# by a capitalised word is kept too, since the digits may belong to an address. A "["
# ends the match, so a query that holds a placeholder such as [NAME] is kept as it is.
_URL_QUERY = (
    r"(?:[?#]"
    r"(?:[A-Za-z_][\w.-]*=[^\s<>\"'\[]{20,}(?=[\s<>\"'\]]|$)"
    r"|[^\s<>\"'\[=]{20,}(?=[\s<>\"'\]]|$)"
    r"|[0-9](?=[0-9A-Za-z_-]*[A-Za-z])[0-9A-Za-z_-]{5,}(?=[\s<>\"'\]]|$)"
    r"|(?![A-Za-z_]{1,8}=[0-9]{1,6}\s+(?-i:[A-Z]))[A-Za-z_][^\s<>\"'\[]*(?=[\s<>\"'\]]|$)"
    r"(?!\s+(?:[0-9]{2,}[ .-][0-9]{2,}|[0-9]{5,}|\+|\((?=[0-9])|\[))"
    r"))?"
)
_URL_TAIL = _URL_PATH + _URL_QUERY
# A host with an optional port: a dotted name that ends in letters, or an IPv4 address.
_HOST = (
    r"(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|(?:[0-9]{1,3}\.){3}[0-9]{1,3})"
    r"(?::[0-9]{1,5})?"
)
_URL_RE = re.compile(
    # A URL with a scheme or www., such as https://example.com/pay?x=1 or www.example.com.
    r"(?<![\w@.-])(?:[A-Za-z][A-Za-z0-9+.-]*://|www\.)[^\s<>\"'?#/]*"
    + _URL_TAIL
    # A bare host followed by a path, query or fragment, such as example.com/pay?x=1 or
    # example.com?token=abc. _sanitise_url decides what, if anything, to remove.
    + r"|(?<![\w@.-])"
    + _HOST
    + r"(?=[/?#])"
    + _URL_TAIL,
    re.IGNORECASE,
)
_SCHEME_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
_TOKEN_SEGMENT_RE = re.compile(
    r"(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{20,}"
)

# The local part of an address. An apostrophe or an exclamation mark is allowed only after
# a letter, so a digit glued before an address with either mark is not swallowed by it.
_EMAIL_LOCAL = r"(?:[\w.%+-]|(?<=[^\W\d_])!|(?<=[^\W\d_])'(?=[^\W\d_]))+"
# A dotted domain that ends in letters, or an IPv4 address, optionally in brackets.
_EMAIL_DOMAIN = (
    r"(?:[\w-]+(?:\.[\w-]+)*\.[^\W\d_]{2,}|\[?(?:[0-9]{1,3}\.){3}[0-9]{1,3}\]?)"
)
_EMAIL_RE = re.compile(
    # The lookbehind stops a match from starting in the middle of a longer local part.
    # Nothing follows the top-level domain except the path or query tail, so a digit or
    # a hyphen right after it does not stop the match.
    r"(?<![\w.%+-])" + _EMAIL_LOCAL + r"@" + _EMAIL_DOMAIN + _URL_TAIL
)

_IBAN_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?:[ -]{0,2}[A-Za-z0-9]){11,30}"
)

_PHONE_RE = re.compile(
    r"(?<![0-9+])"
    r"(?:"
    # A WhatsApp link carries its number without a plus sign.
    r"(?<=wa\.me/)[0-9]{8,15}"
    r"|"
    # +44 20 7946 0958, +1 (555) 123-4567, +33 6 12 34 56 78
    r"\+[0-9]{1,3}(?:[ .-]?\(?[0-9]{1,4}\)?){2,5}"
    # 0044 20 7946 0958
    r"|00[1-9][0-9]{0,2}(?:[ .-]?\(?[0-9]{1,4}\)?){2,5}"
    # (555) 123-4567, (555)123-4567, 555-123-4567, 555.123.4567
    r"|(?:1[ .-])?(?:\([0-9]{3}\)[ .-]?|[0-9]{3}[ .-])[0-9]{3}[ .-][0-9]{4}"
    # 1 212 555 0198, and 5551234567
    r"|1[2-9][0-9]{2}[2-9][0-9]{6}"
    r"|[2-9][0-9]{2}[2-9][0-9]{6}"
    # 020 7946 0958, 0121 496 0000
    r"|0[0-9]{2,4}[ .-][0-9]{3,4}[ .-][0-9]{3,4}"
    # 01234 567890
    r"|0[0-9]{4}[ -][0-9]{6}"
    # 07700900123
    r"|0[0-9]{9,10}"
    # 06 12 34 56 78
    r"|0[0-9](?:[ .-][0-9]{2}){4}"
    # 07700900 123, a 0-led number in more than one group. A zero that follows a digit and a
    # comma or dot, as in 1,000,000 or 1.000.000, starts a thousands group, not a phone number.
    r"|(?<![0-9][,.])0(?=(?:[ .-]?[0-9]){9,10}(?![0-9]))[0-9]{2,10}(?:[ .-][0-9]{1,6}){1,3}"
    r")"
    # A digit after the number would mean the match stopped in the middle of a longer run.
    r"(?![0-9])"
)

# A run of digit groups. Groups are separated by one or two spaces (a non-breaking space
# counts) or by one hyphen. Each group is a run of digits. Dots are not separators here,
# because decimals such as 3.14159 are common in ordinary text.
_CARD_RUN_RE = re.compile(r"[0-9]+(?:(?:[ \t\u00a0]{1,3}|-)[0-9]+)*")
# Four groups of four digits joined by dots, as in 4111.1111.1111.1111.
_DOT_CARD_RE = re.compile(r"(?<![0-9])[0-9]{4}(?:\.[0-9]{4}){3}(?![0-9])")
_CARD_GROUP_RE = re.compile(r"[0-9]+")
# Separated dates and times. They are masked before the card search, so that a card never
# runs into one of them.
_DATE_OR_TIME_RE = re.compile(
    r"(?<![0-9])(?:"
    r"[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2}"
    r"|[0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{2}(?:[0-9]{2})?"
    r"|[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?"
    r")(?![0-9])"
)

_ADDRESS_RE = re.compile(
    r"(?<![\w.])[0-9]{1,6}(?:-[0-9]{1,6}|-?[A-Za-z])?,?\s+"
    # A storage or speed unit after a number is not the start of a street name.
    r"(?!(?:TB|GB|MB|KB|PB|GHz|MHz)\b)"
    r"(?:[A-ZÀ-ÖØ-Þ][\w'’-]*\.?\s+){1,3}"
    r"(?i:" + _SUFFIX_ALTERNATION + r")\b"
)


_URL_TRAILING = ".,;:!?)]}"


def _sanitise_url(raw: str) -> tuple[str, bool]:
    """Drop the query, fragment, userinfo and token-like path segments from a URL."""
    core = raw.rstrip(_URL_TRAILING)
    trailing = raw[len(core) :]
    cut = min(
        (index for index in (core.find("?"), core.find("#")) if index != -1),
        default=len(core),
    )
    changed = cut != len(core)
    # Punctuation that ends the kept part, such as the dot in "x.#top", moves to the
    # trailing part. Otherwise the token check would see it, and a second pass would
    # redact a token that the first pass left in place.
    head = core[:cut].rstrip(_URL_TRAILING)
    trailing = core[len(head) : cut] + trailing
    scheme_match = _SCHEME_RE.match(head)
    scheme = scheme_match.group(0) if scheme_match else ""
    rest = head[len(scheme) :]
    slash = rest.find("/")
    authority, path = (rest, "") if slash == -1 else (rest[:slash], rest[slash:])
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
        changed = True
    segments: list[str] = []
    for segment in path.split("/"):
        if _TOKEN_SEGMENT_RE.fullmatch(segment):
            segments.append("[TOKEN]")
            changed = True
        else:
            segments.append(segment)
    if not changed:
        return raw, False
    return scheme + authority + "/".join(segments) + trailing, True


def _luhn_ok(digits: str) -> bool:
    total = 0
    parity = len(digits) % 2
    for index, ch in enumerate(digits):
        value = int(ch)
        if index % 2 == parity:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def _is_compact_timestamp(digits: str) -> bool:
    try:
        datetime.strptime(digits, "%Y%m%d%H%M%S")
    except ValueError:
        return False
    return True


def _is_card(digits: str) -> bool:
    if not 13 <= len(digits) <= 19:
        return False
    if len(digits) == 14 and _is_compact_timestamp(digits):
        return False
    return _luhn_ok(digits)


def _iban_checksum_ok(value: str) -> bool:
    compact = value.replace(" ", "").replace("-", "").upper()
    if not 15 <= len(compact) <= 34:
        return False
    rearranged = compact[4:] + compact[:4]
    number = int("".join(str(int(ch, 36)) for ch in rearranged))
    return number % 97 == 1


# Registered IBAN lengths (ISO 13616) for the countries that use the IBAN. When the
# country code is one of these, the IBAN is exactly that long, so the cut is exact.
_IBAN_LENGTHS = {
    "AD": 24,
    "AE": 23,
    "AL": 28,
    "AT": 20,
    "AZ": 28,
    "BA": 20,
    "BE": 16,
    "BG": 22,
    "BH": 22,
    "BR": 29,
    "BY": 28,
    "CH": 21,
    "CR": 22,
    "CY": 28,
    "CZ": 24,
    "DE": 22,
    "DK": 18,
    "DO": 28,
    "EE": 20,
    "EG": 29,
    "ES": 24,
    "FI": 18,
    "FO": 18,
    "FR": 27,
    "GB": 22,
    "GE": 22,
    "GI": 23,
    "GL": 18,
    "GR": 27,
    "GT": 28,
    "HR": 21,
    "HU": 28,
    "IE": 22,
    "IL": 23,
    "IS": 26,
    "IT": 27,
    "JO": 30,
    "KW": 30,
    "KZ": 20,
    "LB": 28,
    "LC": 32,
    "LI": 21,
    "LT": 20,
    "LU": 20,
    "LV": 21,
    "MC": 27,
    "MD": 24,
    "ME": 22,
    "MK": 19,
    "MR": 27,
    "MT": 31,
    "MU": 30,
    "NL": 18,
    "NO": 15,
    "PK": 24,
    "PL": 28,
    "PS": 29,
    "PT": 25,
    "QA": 29,
    "RO": 24,
    "RS": 22,
    "SA": 24,
    "SC": 31,
    "SE": 24,
    "SI": 19,
    "SK": 24,
    "SM": 27,
    "ST": 25,
    "SV": 28,
    "TL": 23,
    "TN": 24,
    "TR": 26,
    "UA": 29,
    "VA": 22,
    "VG": 24,
    "XK": 20,
}


def _alnum_end(text: str, count: int) -> int | None:
    """Index just after the count-th ASCII letter or digit in text, or None if too few."""
    seen = 0
    for index, ch in enumerate(text):
        if ch.isascii() and ch.isalnum():
            seen += 1
            if seen == count:
                return index + 1
    return None


def _iban_prefix(candidate: str) -> str | None:
    """The IBAN at the start of the candidate, or None.

    Only a country whose registered length is listed here is read as an IBAN. The IBAN is
    exactly that length, so the cut is taken there, even inside a run of letters, and it
    must pass mod-97. Any other country code is not read as an IBAN, since a mod-97 check
    passes by chance about one time in a hundred.
    """
    length = _IBAN_LENGTHS.get(candidate[:2].upper())
    if length is None:
        return None
    end = _alnum_end(candidate, length)
    if end is None or not _iban_checksum_ok(candidate[:end]):
        return None
    return candidate[:end]


def _phone_span(candidate: str) -> str | None:
    """Longest prefix that ends at a digit-run boundary and holds 8 to 15 digits."""
    ends = [
        index + 1
        for index, ch in enumerate(candidate)
        if ch in _DIGITS
        and (index + 1 == len(candidate) or candidate[index + 1] not in _DIGITS)
    ]
    for end in reversed(ends):
        digit_count = sum(1 for ch in candidate[:end] if ch in _DIGITS)
        if 8 <= digit_count <= 15:
            return candidate[:end]
    return None


def _mask_dates(text: str) -> str:
    """Replace each separated date or time with letters of the same length."""
    return _DATE_OR_TIME_RE.sub(lambda match: "x" * len(match.group(0)), text)


def _card_spans(groups: list[tuple[int, int, str]]) -> list[tuple[int, int]]:
    """Spans of the cards in one run of digit groups, with no digit used twice.

    A card starts at the first digit of a group and runs 13 to 19 digits. Among the
    candidates, one that ends at the end of a group is preferred, then the longer one,
    then the one further left. A candidate that ends inside a group is used only in a
    group of 16 digits or more, so a card with its security code glued on is still found,
    while a 14-digit timestamp is not split.
    """
    digits = "".join(group[2] for group in groups)
    pos_start: list[int] = []
    pos_end: list[int] = []
    group_last: list[bool] = []
    first: list[int] = []
    for start, _end, text in groups:
        first.append(len(pos_start))
        for offset in range(len(text)):
            pos_start.append(start + offset)
            pos_end.append(start + offset + 1)
            group_last.append(offset == len(text) - 1)
    candidates: list[tuple[bool, int, int, int]] = []
    for group_index, (_start, _end, text) in enumerate(groups):
        a0 = first[group_index]
        for length in range(13, 20):
            e = a0 + length - 1
            if e >= len(digits):
                break
            if not group_last[e] and len(text) < 16:
                continue
            if _is_card(digits[a0 : e + 1]):
                candidates.append((not group_last[e], -length, a0, e))
    candidates.sort()
    used = [False] * len(digits)
    spans: list[tuple[int, int]] = []
    for _partial, _negative, a0, e in candidates:
        if any(used[a0 : e + 1]):
            continue
        used[a0 : e + 1] = [True] * (e + 1 - a0)
        spans.append((pos_start[a0], pos_end[e]))
    return spans


def _redact_urls(text: str, counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        cleaned, changed = _sanitise_url(match.group(0))
        if changed:
            counts["url"] += 1
        return cleaned

    return _URL_RE.sub(repl, text)


_PERCENT_EMAIL_RE = re.compile(
    r"(?<![\w.%+-])[\w.%+-]+%40[\w-]+(?:\.[\w-]+)*\.[^\W\d_]{2,}"
)


def _redact_emails(text: str, counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        counts["email"] += 1
        return "[EMAIL]"

    return _PERCENT_EMAIL_RE.sub(repl, _EMAIL_RE.sub(repl, text))


def _redact_ibans(text: str, counts: Counter[str]) -> str:
    pieces: list[str] = []
    pos = 0
    while True:
        match = _IBAN_RE.search(text, pos)
        if match is None:
            break
        prefix = _iban_prefix(match.group(0))
        if prefix is None:
            # Not an IBAN here. Keep the first character and look again from the next one.
            pieces.append(text[pos : match.start() + 1])
            pos = match.start() + 1
            continue
        pieces.append(text[pos : match.start()])
        pieces.append("[IBAN]")
        counts["iban"] += 1
        pos = match.start() + len(prefix)
    pieces.append(text[pos:])
    return "".join(pieces)


def _redact_phones(text: str, counts: Counter[str]) -> str:
    # A phone-shaped run inside a card belongs to the card, which the card rule reads later.
    # Without this check the last twelve digits of a zero-led card are labelled as a phone.
    cards = _card_spans_of(text)

    def repl(match: re.Match[str]) -> str:
        candidate = match.group(0)
        if any(start <= match.start() and match.end() <= end for start, end in cards):
            return candidate
        span = _phone_span(candidate)
        if span is None:
            return candidate
        counts["phone"] += 1
        return "[PHONE]" + candidate[len(span) :]

    return _PHONE_RE.sub(repl, text)


def _card_spans_of(text: str) -> list[tuple[int, int]]:
    """Sorted spans of every card in the text: dotted cards first, then digit runs."""
    masked = _mask_dates(text)
    found: list[tuple[int, int]] = []
    for dotted in _DOT_CARD_RE.finditer(masked):
        if _is_card(dotted.group(0).replace(".", "")):
            found.append((dotted.start(), dotted.end()))
    # A dotted card is masked before the digit runs are read, so they cannot find it again.
    chars = list(masked)
    for start, end in found:
        chars[start:end] = "x" * (end - start)
    masked = "".join(chars)
    for run in _CARD_RUN_RE.finditer(masked):
        groups = [
            (run.start() + group.start(), run.start() + group.end(), group.group(0))
            for group in _CARD_GROUP_RE.finditer(run.group(0))
        ]
        found.extend(_card_spans(groups))
    return sorted(found)


def _redact_cards(text: str, counts: Counter[str]) -> str:
    found = _card_spans_of(text)
    if not found:
        return text
    pieces: list[str] = []
    cursor = 0
    for start, end in sorted(found):
        pieces.append(text[cursor:start])
        pieces.append("[CARD]")
        cursor = end
        counts["card"] += 1
    pieces.append(text[cursor:])
    return "".join(pieces)


def _redact_addresses(text: str, counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        counts["address"] += 1
        return "[ADDRESS]"

    return _ADDRESS_RE.sub(repl, text)


def _alternation(names: Iterable[str]) -> str:
    """Regex alternation for names: longest first, any whitespace run inside a name."""
    ordered = sorted(names, key=len, reverse=True)
    return "|".join(
        r"\s+".join(re.escape(part) for part in name.split()) for name in ordered
    )


_TOKEN_RE = re.compile(r"\[(?:" + "|".join(_TOKEN_WORDS) + r")\]")


def content_words(text: str) -> list[str]:
    """The words of ``text`` with placeholder tokens such as [NAME] left out."""
    return _TOKEN_RE.sub(" ", text).split()


def _with_unicode_forms(names: tuple[str, ...]) -> tuple[str, ...]:
    """Add the spellings of each name that a text may use for the same name.

    The text is already in NFKC form. Canonically equivalent spellings are added, and a
    German sharp s also matches "ss", as in "Grossmann" for "Großmann".
    """
    forms: dict[str, None] = {}
    for name in names:
        for form in (name, unicodedata.normalize("NFC", name)):
            forms[form] = None
        if "ß" in name:
            forms[name.replace("ß", "ss")] = None
        if "ẞ" in name:
            forms[name.replace("ẞ", "SS")] = None
        if "'" in name:
            forms[name.replace("'", "’")] = None
        if "’" in name:
            forms[name.replace("’", "'")] = None
    return tuple(forms)


# A letter or digit that counts as part of a word. Scripts written without spaces are not
# counted, so a name written beside their characters is still a whole word.
_WORD = r"[^\W\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]"


# Scripts written without spaces between words. A name in one of them is matched wherever
# it occurs, because there is no space to mark where a word starts or ends.
_UNSPACED_RANGES = (
    (0x0E00, 0x0EFF),  # Thai and Lao
    (0x1000, 0x109F),  # Myanmar
    (0x1780, 0x17FF),  # Khmer
    (0x3040, 0x30FF),  # Hiragana and Katakana
    (0x3400, 0x4DBF),  # CJK extension A
    (0x4E00, 0x9FFF),  # CJK unified ideographs
    (0xAC00, 0xD7AF),  # Hangul syllables
    (0xF900, 0xFAFF),  # CJK compatibility ideographs
    (0x20000, 0x2FFFF),  # CJK extensions B and later
)


def _is_unspaced(name: str) -> bool:
    return any(low <= ord(ch) <= high for ch in name for low, high in _UNSPACED_RANGES)


def _name_pattern(names: tuple[str, ...]) -> re.Pattern[str] | None:
    """Matches of the names, one per start position.

    A spaced name is a whole word. It is not matched inside an address, where it follows
    "@" or "." after a word, nor when an address (an "@" and a dotted domain) or a file or
    host name (a "." and a lowercase letter or digit) follows it. An unspaced name is matched
    wherever it occurs. The lookahead lets a match start inside another match, so
    overlapping names are all found. Group 1 holds the matched text.
    """
    if not names:
        return None
    spaced = [name for name in names if not _is_unspaced(name)]
    unspaced = [name for name in names if _is_unspaced(name)]
    alternatives: list[str] = []
    if spaced:
        alternatives.append(
            r"(?<!"
            + _WORD
            + r")(?<!"
            + _WORD
            + r"[.@])(?:"
            + _alternation(spaced)
            + r")"
            r"(?!" + _WORD + r")(?!@[\w-]+\.)(?!\.(?-i:[a-z0-9]))"
        )
    if unspaced:
        alternatives.append("(?:" + _alternation(unspaced) + ")")
    return re.compile(r"(?=((?:" + "|".join(alternatives) + r")))", re.IGNORECASE)


def _occurrences(pattern: re.Pattern[str], text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.start() + len(m.group(1))) for m in pattern.finditer(text)]


def _merge(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Join spans that share at least one character."""
    merged: list[tuple[int, int]] = []
    for start, end in sorted(spans):
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _covered_prefix(spans: list[tuple[int, int]], size: int) -> list[int]:
    """Entry i is the number of characters before index i that some span covers."""
    covered = [0] * size
    for start, end in spans:
        covered[start:end] = [1] * (end - start)
    prefix = [0] * (size + 1)
    for index, flag in enumerate(covered):
        prefix[index + 1] = prefix[index] + flag
    return prefix


def _reach(spans: list[tuple[int, int]], size: int) -> list[int]:
    """Entry i is the furthest end of a span that starts at or before index i, or -1."""
    reach = [-1] * (size + 1)
    for start, end in spans:
        reach[start] = max(reach[start], end)
    for index in range(1, size + 1):
        reach[index] = max(reach[index], reach[index - 1])
    return reach


def _redact_names(
    text: str,
    deny: re.Pattern[str] | None,
    allow: re.Pattern[str] | None,
    counts: Counter[str],
) -> str:
    """Replace each denied occurrence with [NAME].

    A denied occurrence stays as written only when an allowed occurrence contains it
    entirely. A denied occurrence that merely overlaps an allowed phrase is redacted. A
    placeholder token such as [NAME] is never a match. Occurrences that overlap one
    another become a single [NAME].
    """
    if deny is None:
        return text
    size = len(text)
    protected = _covered_prefix([m.span() for m in _TOKEN_RE.finditer(text)], size)
    allowed = _occurrences(allow, text) if allow is not None else []
    reach = _reach(allowed, size)
    targets = [
        (start, end)
        for start, end in _occurrences(deny, text)
        if protected[end] == protected[start] and reach[start] < end
    ]
    pieces: list[str] = []
    cursor = 0
    for start, end in _merge(targets):
        pieces.append(text[cursor:start])
        pieces.append("[NAME]")
        cursor = end
        counts["name"] += 1
    pieces.append(text[cursor:])
    return "".join(pieces)


def _clean_names(names: Iterable[str], field: str) -> tuple[str, ...]:
    cleaned: dict[str, None] = {}
    for raw in names:
        name = " ".join(unicodedata.normalize("NFKC", raw).split())
        if not name:
            continue
        if len(name) < 2:
            raise ValueError(f"{field} entry {raw!r} must be at least 2 characters")
        cleaned[name] = None
    return tuple(cleaned)


def _normalise(text: str) -> str:
    """NFKC, with Unicode decimal digits written as ASCII digits.

    Full-width digits, non-breaking spaces and decomposed letters are common in pasted
    text. Writing them in their plain forms first lets every rule below see them.
    """
    folded = unicodedata.normalize("NFKC", text)
    return "".join(
        str(unicodedata.decimal(ch)) if ch.isdecimal() else ch for ch in folded
    )


class Redactor:
    """Applies the redaction rules described in the module docstring.

    This is a pure helper. It keeps no state beyond its compiled name patterns, reads no
    environment variables, and has no caller in the runtime yet. Its only caller is
    ``persona_extractor.build_tone_examples``, which is off unless
    ``HBPE_TONE_EXAMPLES_ENABLED`` is set.
    """

    def __init__(
        self,
        *,
        deny_names: Iterable[str] = (),
        allow_names: Iterable[str] = (),
    ) -> None:
        deny = _clean_names(deny_names, "deny_names")
        allow = _clean_names(allow_names, "allow_names")
        clash = {name.casefold() for name in deny} & {name.casefold() for name in allow}
        if clash:
            raise ValueError(
                f"names appear on both deny_names and allow_names: {sorted(clash)}"
            )
        self._deny_pattern = _name_pattern(_with_unicode_forms(deny))
        self._allow_pattern = _name_pattern(_with_unicode_forms(allow))

    def redact(self, text: str) -> tuple[str, dict[str, int]]:
        """Return the redacted text and the number of replacements per category.

        The rules run again on their own output until a pass changes nothing. The
        result is a fixed point, so redacting it a second time changes nothing. Each
        change removes at least one character that is not part of a placeholder, so the
        loop ends.
        """
        counts: Counter[str] = Counter()
        current = _normalise(text)
        while True:
            step = self._redact_pass(current, counts)
            if step == current:
                return current, dict(counts)
            current = step

    def _redact_pass(self, text: str, counts: Counter[str]) -> str:
        out = _redact_names(text, self._deny_pattern, self._allow_pattern, counts)
        out = _redact_urls(out, counts)
        out = _redact_emails(out, counts)
        out = _redact_ibans(out, counts)
        out = _redact_phones(out, counts)
        out = _redact_cards(out, counts)
        return _redact_addresses(out, counts)
