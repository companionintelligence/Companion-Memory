"""
Deterministic redaction for text that becomes tone-adapter training data.

``Redactor.redact(text)`` returns ``(redacted_text, counts)``. ``counts`` maps each
category that matched to its number of replacements, and categories with no match are
left out. The output depends only on the input and the configured names, so the same
input always gives the same output, and redacting a second time changes nothing.

Its callers are ``persona_extractor.build_tone_examples``, which is off unless
``HBPE_TONE_EXAMPLES_ENABLED`` is set, and ``PersonaDataExtractor.extract_decision_items``,
which redacts every free-text field of the decision export.

Before any rule runs, the text is put into Unicode NFKC form, and Unicode decimal digits
are written as ASCII digits, so full-width and Arabic-Indic digits are read as digits.

The rules run in the order below, and the whole set repeats until a pass changes
nothing. Names run first, so a denied name is replaced before a query or a number next
to it is removed.

- ``name``: caller-supplied names, matched case-insensitively as whole words, become
  ``[NAME]``. A name is left alone when it is followed by ``@`` and a dotted domain, or by
  ``.`` and a lowercase letter or digit, and when it follows ``@`` or ``.`` after a word,
  so an address or a host name is not broken up. A name written in a script without
  spaces, such as Chinese or Japanese, is matched wherever it occurs, and a spaced name
  beside such a script is still a whole word, so ``Chat Sarahさん`` becomes ``Chat [NAME]さん``.
  Both the precomposed and the decomposed spelling of a name match, a German sharp s also
  matches ``ss``, and a straight apostrophe matches a curly one.
- ``url``: a URL with a query string or fragment, with credentials (``user:pass@``), or
  with a token-like path segment. A URL is text that starts with a scheme, such as
  ``https://`` or ``postgres://``, or with ``www.``, or with a host, optionally followed by
  a port, and then a path, query or fragment, such as ``example.com/pay?x=1``. The scheme,
  host and path are kept. The query, the fragment and the credentials are dropped. A path
  segment of at least 20 letters, digits or underscores, with both a letter and a digit,
  becomes ``[TOKEN]``. A query value of 20 or more characters is always dropped. A shorter
  query is kept only when a phone number, a card or a placeholder follows it straight away,
  or when a street address follows it, as in ``?q=221 Baker Street``. Any other shorter
  query is dropped, so a one-time code followed by words goes with it. A URL with none of
  these is left alone.
- ``email``: an address with a dotted domain, or with an IPv4 domain, such as
  ``sarah@example.com``, becomes ``[EMAIL]``, and a path or query directly after it goes
  with it. Letters from any script count, so ``josé@example.com`` is caught. An apostrophe
  or an exclamation mark may sit inside the local part, but only after a letter, so
  ``o'brien@example.com`` is caught whole, and a digit glued before an address with either
  mark is not swallowed.
- ``secret``: a value after a keyword such as ``password``, ``PIN``, ``api_key``, ``token`` or
  ``clientSecret`` becomes ``[SECRET]``, and the keyword and its separator are kept. A separator
  is a colon, an equals sign, a fat arrow, an arrow, a closing angle bracket or a quote, or else
  a space or the word ``is``, ``was`` or ``are``. A keyword followed by a closing square bracket
  and then an equals sign, as in ``config["password"] =``, is a separator too. A keyword in
  quotes followed by a space and a value, as in ``"password" "hunter2"``, is read too. A word
  followed by a colon or an equals sign, as in ``is:``, is a strong separator. A quote may be
  escaped with a backslash, as in JSON inside a string, and a quote inside a quoted value may be
  escaped too. A bracket in front of a value encloses it and is kept, so the value inside ( ) or
  [ ] or < > is redacted. After a strong separator the value is at least four characters. After
  a space or a word it must hold a digit or a symbol other than an apostrophe, or be at least
  twelve characters, so that "reset my password please" is kept. A bare ``pass``, which is also
  a verb, needs a strong separator or ``is`` after it. A PIN, a one-time code or a CVV is
  digits, or digits with letters, and a run of more than ten digits is left to the card rule. A
  quoted value of up to 4,096 characters is redacted to its closing quote, so a passphrase with
  spaces is redacted whole. Curly double quotes count as quotes too. A keyword may begin a
  camel-case word, as in ``dbPassword``. A password in the credentials of a URL, and a token in
  a known format, such as an AWS key ID, a Stripe, GitHub, Slack or Google key, a JSON Web
  Token, a bearer token or a private key block, becomes ``[SECRET]`` whole. A private key block
  runs to its END line, or else over the base64 lines after its BEGIN line.
- ``iban``: an IBAN of a country whose registered length is listed in this module, taken at
  that length, becomes ``[IBAN]`` when it passes the mod-97 check, even when it is glued to
  letters. Spaces, tabs and hyphens may separate its groups. For any other country, the
  longest prefix that ends before a separator and passes the check is taken.
- ``phone``: numbers with a leading ``+`` or ``00``, North American numbers, and UK and
  French style national numbers become ``[PHONE]``. A UK national number that starts with
  0 and is written as an 8-digit group and a 2- or 3-digit group, such as ``07700900 123``,
  is caught too. A match must carry 8 to 15 digits. A number may follow a letter, so
  ``call07700900123`` is caught.
- ``card``: the longest run of whole digit groups that passes the Luhn check becomes
  ``[CARD]``. Groups are separated by one to three spaces, tabs or non-breaking spaces, or by
  a hyphen. A card may also be written as four groups of four digits joined by dots.
  Separated dates and times are masked before the search, so a card never runs into one. A
  security code of three or four digits that is the last group of the run is part of the
  card, as in ``4111 1111 1111 1111 123``, and a card with its security code glued on, as in
  ``4111111111111111123``, is found. Other digits after a card are kept. A 14-digit
  ``YYYYMMDDhhmmss`` stamp is not treated as a card. Phones and cards compete for the same
  digits, so they are read two ways and every digit either reading hides is replaced. One
  reading protects only a card written alone as four groups of four digits, so a phone beside
  a card is found first. The other leaves any phone match inside a card to the card rule.
- ``address``: a house number, optionally with a hyphenated letter or a second number, such
  as ``221B``, ``221-B`` or ``12-14``, and optionally with a comma, one to three capitalised
  words, the first of which may be an accented capital, and a street suffix
  (Street, Road, Avenue, Way, Circle, Trail, Plaza, Path, Loop, Str and so on) become
  ``[ADDRESS]``. A storage or memory unit, such as TB or GB, cannot be the first word.


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
marks a domain or a file name. 7-digit local phone numbers, including one that follows a longer
number, lowercase street addresses, postcodes, and names that are not listed. A name inside a
host label, such as ``sarah.example.com``, is not redacted. Digits glued straight to an address
with no space, such as ``4111 1111 1111 1111sarah@example.com``, have the glued group taken into
the address, so the rest of the number stays. A product name such as ``2 Google Drive`` can
match the address rule. The userinfo of a URL whose password contains a slash is not stripped. A
card written with slashes or with line breaks is not recognised, and neither is a quoted local
part such as ``"sarah"@example.com``. A phone number written with a space after the plus sign,
such as ``+ 44 20 7946 0958``, or with a bracketed zero, such as ``(0)20 7946 0958``, is not
matched, and neither is a national number without a plus sign or a 00 prefix outside North
America, the UK and France. A UUID in a path is not treated as a token. A short value followed
by two digit groups in a query is kept, as in ``?ref=abc 12 34``, so a short token there is not
removed. A house number glued to a word, as in ``Flat221 Baker Street``, is not matched. An
unseparated North American number whose exchange starts with 0 or 1, such as ``5551234567``, is
not read as a phone number, though the separated form ``555-123-4567`` is. A secret with no
keyword and no known format, such as a password written on its own, is not redacted. After a
strong separator only the first word of an unquoted value is redacted, so the rest of a
passphrase such as correct horse battery stays in the text. A squashed key, such as mypassword=,
is not matched, nor is a spaced dash, as in password - hunter2, nor a keyword with a zero-width
space in it. A denied name spelt like a keyword, such as a contact called Token, removes that
keyword first. Bank sort codes and national insurance numbers are not redacted either. A bare
value runs to the next space, so a second keyword glued to it, as in password:hunter2|pin: 4321,
leaves its own value unredacted. A keyword in a URL query or an e-mail path does not reach a
secret after a space, as in https://x.com/?note=password: hunter2, and a slash is not a
separator, as in /password/hunter2. A bare pass followed only by a space, as in wifi pass
12345678, is not redacted, since pass is also a verb. A quoted value of more than 4,096
characters is not redacted beyond its first space, which bounds the work done for each keyword.
An address whose local part is longer than 64 characters, which RFC 5321 does not allow, is not
read. A query key of more than 256 characters, or a key-less query value of more than 256, is
not read, which keeps the scan linear. A quote glued to a connector word, as in is"x", must
enclose one word, since a quote after "is" may close a phrase. An angle bracket ends a bare
value, since it marks markup, as in ``<password>hunter2</password>``, so a value such as
``Pa<ss>word9`` is cut there. Only one level of backslash escaping is read. The name, card, IBAN
and phone rules are quadratic on long runs of their own kind, such as "Sarah@" repeated 2,000
times, which takes about a second, or 20,000 digits, which take about 16 seconds, and a run of
glued IBANs or phone numbers takes one pass per number, and a chain of values after
placeholders, as in "[SECRET] =abcd", takes one pass per value. These rules predate the secret
rules and are not changed here. Two kinds of over-redaction are accepted, because narrowing
either would leak words that are secrets: a hyphen counts as a symbol, so ``The token is well-
known`` gives ``The token is [SECRET]``, and a strong separator takes any word, so ``Boarding
pass: Gate`` gives ``Boarding pass: [SECRET]``. Also not matched: UK numbers with a bracketed
area code, such as ``(020) 7946 0958``; street suffixes outside the list, and ordinal street
names such as ``45 West 23rd Street``; postcodes; eight- or nine-digit compact numbers; dates of
birth in separated or long forms; written-out e-mail addresses; and a zero-width space inside a
name.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable
from datetime import datetime

CATEGORIES: tuple[str, ...] = (
    "url",
    "secret",
    "email",
    "iban",
    "phone",
    "card",
    "address",
    "name",
)

_DIGITS = "0123456789"
# Placeholder tokens written by the rules below. The name rule never touches them.
_TOKEN_WORDS = ("EMAIL", "PHONE", "CARD", "IBAN", "ADDRESS", "NAME", "TOKEN", "SECRET")
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
_URL_PATH = r"(?:/(?:[^\s<>\"'?#]|'(?=[^\W_]))*)?"
# The query or fragment of a URL, which is dropped with the URL. A value of 20 or more
# characters, with any text in front of its "=", such as 2fa or filter[token], is always
# dropped. A shorter value is kept only when a phone number, a card or a placeholder follows it
# straight away, since dropping it there would cut into that number. A value that ends in a
# digit and is followed by a capitalised word is kept too, since the digits may belong to an
# address. A "[" ends the match. A short query that ends at a "[" is kept as it is, since the
# bracket may begin a placeholder such as [NAME]; a long one is dropped, as the rule above says.
_URL_QUERY = (
    r"(?:[?#]"
    r"(?:[^\s<>\"'=]{0,256}=(?:[^\s<>\"'\[]|'(?=[^\W_])){20,}(?=[\s<>\"'\[\]]|$)"
    r"|[^\s<>\"'=]{0,256}=(?:\"[^\"\n]{1,4096}\"|'[^'\n]{1,4096}')(?=[\s<>\"'\[\]\.,;:!?)]|$)"
    r"|(?:[^\s<>\"'\[]|'(?=[^\W_]))(?:[^\s<>\"'\[]|'(?=[^\W_])){0,255}(?=[\s<>\"'\[\]]|$)"
    r"(?!\s+(?:[0-9]{2,}[ .-][0-9]{2,}|[0-9]{5,}|\+|\((?=[0-9])|\[))"
    r"(?!(?<=[0-9])\s+(?-i:[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,2})\s+(?:"
    + _SUFFIX_ALTERNATION
    + r")\b)"
    r"|(?:[^\s<>\"'\[=]|'(?=[^\W_])){20,}=(?:[^\s<>\"'\[]|'(?=[^\W_])){20,}(?=[\s<>\"'\[\]]|$)"
    r"|(?:[^\s<>\"'\[=]|'(?=[^\W_])){20,}={0,2}(?=[\s<>\"'\[\]=]|$)"
    r"|[0-9](?=[0-9A-Za-z_-]*[A-Za-z])[0-9A-Za-z_-]{5,}={0,2}(?=[\s<>\"'\[\]]|$)"
    r"))?"
)
_URL_TAIL = _URL_PATH + _URL_QUERY
# A query or fragment that is dropped whatever follows it: the value the alternatives above
# drop on their own, with its padding. It is checked when a query ends at a "[".
_LONG_QUERY_RE = re.compile(
    r"[?#](?:[^\s<>\"'=]{0,256}=(?:[^\s<>\"'\[]|'(?=[^\W_])){20,}"
    r"|[^\s<>\"'=]{0,256}=(?:\"[^\"\n]{1,4096}\"|'[^'\n]{1,4096}')"
    r"|(?:[^\s<>\"'\[=]|'(?=[^\W_])){20,}=(?:[^\s<>\"'\[]|'(?=[^\W_])){20,}"
    r"|(?:[^\s<>\"'\[=]|'(?=[^\W_])){20,}={0,2}"
    r"|[0-9](?=[0-9A-Za-z_-]*[A-Za-z])[0-9A-Za-z_-]{5,}={0,2})"
)

# A host with an optional port: a dotted name that ends in letters, or an IPv4 address.
_HOST = (
    r"(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|(?:[0-9]{1,3}\.){3}[0-9]{1,3})"
    r"(?::[0-9]{1,5})?"
)
_URL_RE = re.compile(
    # A URL with a scheme or www., such as https://example.com/pay?x=1 or www.example.com.
    r"(?<![\w@.+-])(?:[A-Za-z][A-Za-z0-9+.-]*://|www\.)[^\s<>\"'?#/]*"
    + _URL_TAIL
    # A bare host followed by a path, query or fragment, such as example.com/pay?x=1 or
    # example.com?token=abc. _sanitise_url decides what, if anything, to remove.
    + r"|(?<![\w@.+-])"
    + _HOST
    + r"(?=[/?#])"
    + _URL_TAIL,
    re.IGNORECASE,
)
_SCHEME_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
_TOKEN_SEGMENT_RE = re.compile(
    r"(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{20,}"
)

# The local part of an address, which RFC 5321 limits to 64 characters, so each attempt is
# bounded. An apostrophe or an exclamation mark is allowed only after a letter, so a digit
# glued before an address with either mark is not swallowed by it.
_EMAIL_LOCAL = r"(?:[\w.%+-]|(?<=[^\W\d_])!|(?<=[^\W\d_])'(?=[^\W\d_])){1,64}"
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

# The address without its query, used when a query ends at a "[".
_EMAIL_BASE_RE = re.compile(r"(?<![\w.%+-])" + _EMAIL_LOCAL + r"@" + _EMAIL_DOMAIN)


_IBAN_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?:[ \t-]{0,2}[A-Za-z0-9]){11,40}"
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
    # 07700900 123: a 0-led national number in two groups, not after a digit and a comma or dot.
    r"|(?<![0-9][,.])0[0-9]{7}[ .-][0-9]{2,3}"
    # 06 12 34 56 78
    r"|0[0-9](?:[ .-][0-9]{2}){4}"
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
    # A house number, with an optional hyphenated letter and an optional comma.
    r"(?<![\w.])[0-9]{1,6}(?:-?[A-Za-z]|-[0-9]{1,6})?,?\s+"
    # A storage or memory unit after a number is not the start of a street name.
    r"(?!(?:TB|GB|MB|KB|PB|GHz|MHz)\b)"
    # One to three capitalised words, which may begin with an accented capital.
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
    compact = "".join(ch for ch in value if ch.isascii() and ch.isalnum()).upper()
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

    For a known country the IBAN is exactly its registered length, so the cut is taken
    there, even inside a run of letters, and must pass mod-97. For any other country the
    longest prefix that ends before a space, tab or hyphen and passes mod-97 is taken.
    """
    length = _IBAN_LENGTHS.get(candidate[:2].upper())
    if length is not None:
        end = _alnum_end(candidate, length)
        if end is None or not _iban_checksum_ok(candidate[:end]):
            return None
        return candidate[:end]
    ends = [index for index, ch in enumerate(candidate) if ch in " \t-"]
    ends.append(len(candidate))
    for end in reversed(ends):
        prefix = candidate[:end]
        if _iban_checksum_ok(prefix):
            return prefix
    return None


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
    while a 14-digit timestamp is not split. A security code of three or four digits that
    is the last group of the run is taken with the card.
    """
    digits = "".join(group[2] for group in groups)
    total = len(digits)
    pos_start: list[int] = []
    pos_end: list[int] = []
    group_last: list[bool] = []
    group_of: list[int] = []
    group_end: list[int] = []
    first: list[int] = []
    for index, (start, _end, text) in enumerate(groups):
        first.append(len(pos_start))
        for offset in range(len(text)):
            pos_start.append(start + offset)
            pos_end.append(start + offset + 1)
            group_last.append(offset == len(text) - 1)
            group_of.append(index)
        group_end.extend([len(pos_start) - 1] * len(text))
    candidates: list[tuple[bool, int, int, int]] = []
    for group_index, (_start, _end, text) in enumerate(groups):
        a0 = first[group_index]
        for length in range(13, 20):
            e = a0 + length - 1
            if e >= total:
                break
            if not group_last[e] and len(text) < 16:
                continue
            if _is_card(digits[a0 : e + 1]):
                candidates.append((not group_last[e], -length, a0, e))
    candidates.sort()
    used = [False] * total
    spans: list[tuple[int, int]] = []
    for _partial, _negative, a0, e in candidates:
        if any(used[a0 : e + 1]):
            continue
        end = e
        if not group_last[e]:
            # The rest of the group is a security code when it has three or four digits.
            if 3 <= group_end[e] - e <= 4 and not any(used[e + 1 : group_end[e] + 1]):
                end = group_end[e]
        elif group_of[e] + 2 == len(groups) and e + 1 < total:
            # The next group is the last of the run and holds a security code.
            last = group_end[e + 1]
            if 3 <= last - e <= 4 and not any(used[e + 1 : last + 1]):
                end = last
        used[a0 : end + 1] = [True] * (end + 1 - a0)
        spans.append((pos_start[a0], pos_end[end]))
    return spans


def _redact_urls(text: str, counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        raw = match.group(0)
        if match.string[match.end() : match.end() + 1] == "[":
            query = min(
                (raw.find(mark) for mark in "?#" if mark in raw), default=len(raw)
            )
            if _LONG_QUERY_RE.fullmatch(raw, query) is None:
                # A short query that ends at a "[" is kept as written, since the bracket may
                # begin a placeholder such as [NAME]. Only the part before it is read, so the
                # scan stays linear.
                cleaned, changed = _sanitise_url(raw[:query])
                if changed:
                    counts["url"] += 1
                return cleaned + raw[query:]
        cleaned, changed = _sanitise_url(raw)
        if changed:
            counts["url"] += 1
        return cleaned

    return _URL_RE.sub(repl, text)


# Secrets. A token in a known format is replaced whole. A value after a keyword such as
# password, PIN or api_key is replaced, and the keyword and its separator are kept, so the
# item still says what was there. A placeholder is never replaced again, so a second pass
# changes nothing. The token rules run after the URL rule and before the e-mail rule, and the
# keyword rule after the e-mail rule, so that a query string is dropped before its keyword is
# read. Both run before the IBAN, phone and card rules, so no later rule can split a secret.
_SECRET_TOKEN_RES = (
    # AWS access key IDs.
    re.compile(
        r"(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}"
        r"(?![A-Za-z0-9])"
    ),
    # Stripe-style live and test keys.
    re.compile(
        r"(?<![A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{8,}(?![A-Za-z0-9])"
    ),
    # GitHub tokens.
    re.compile(r"(?<![A-Za-z0-9])gh[pousr]_[0-9A-Za-z]{20,}(?![A-Za-z0-9])"),
    # Slack tokens.
    re.compile(r"(?<![A-Za-z0-9])xox[abposr]-[0-9A-Za-z-]{10,}(?![A-Za-z0-9])"),
    # Google API keys.
    re.compile(r"(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}(?![0-9A-Za-z_-])"),
    # JSON Web Tokens: three dot-separated parts, the first starting with eyJ.
    re.compile(
        r"(?<![0-9A-Za-z_-])eyJ[0-9A-Za-z_-]{6,}\.[0-9A-Za-z_-]{6,}\.[0-9A-Za-z_-]{6,}"
        r"(?![0-9A-Za-z_-])"
    ),
    # A private key block: its BEGIN line, the base64 lines of its body, and its END line
    # when there is one. A line that is not base64, such as a question, ends the block.
    re.compile(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"
        r"(?:\r?\n[A-Za-z0-9+/=]{4,}(?=[ \t\r]*(?:\n|\Z)))*"
        r"(?:\r?\n-----END [A-Z0-9 ]*PRIVATE KEY-----)?"
    ),
)
# A bearer token. The word Bearer is kept.
_BEARER_RE = re.compile(
    r"(?<![A-Za-z0-9])(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*(?![A-Za-z0-9])"
)
# The password in the credentials of a URL. The URL rule stops at a ? or a #, so a password
# that holds one is not reached by it. The scheme and the username are kept. A placeholder
# password is left alone, so a second pass does not count it again.
_URL_CREDENTIALS_RE = re.compile(
    r"(?<![A-Za-z+.-])([A-Za-z][A-Za-z0-9+.-]{0,30}://[^\s/@:]*:)(?!\[SECRET\]@)[^\s/@]+@"
)
# Keywords that introduce a secret. The longer forms are listed first. "pass" is not in this
# list: it is also a common word, so _SECRET_KEYWORD_RE tries it last, and only with a strong
# separator or "is" after it.
_SECRET_KEYWORDS = (
    r"one[ -]time (?:password|code|pin)|pass[ _-]?words?|pass[ _-]?phrases?|passwd|"
    r"pass[ _-]?codes?|pwd|pin code|pincode|pin|otp|verification code|security code|cvv|cvc|"
    r"secret[ _-]?key|secret|api[ _-]?key|api[ _-]?secret|access[ _-]?key|"
    r"access[ _-]?token|auth[ _-]?token|token"
)
# A keyword starts at a word start. It also starts at a camel-case boundary: a capital that
# follows a lower-case letter or a digit, as in dbPassword and oauth2Token, or a capital that
# begins a word after an acronym, as in APIToken. A squashed key, such as mypassword, is not
# matched. The boundary tests are case-sensitive, because the keyword is not.
_SECRET_KEYWORD_RE = re.compile(
    r"(?:(?<![A-Za-z0-9])|(?<=(?-i:[a-z0-9]))(?=(?-i:[A-Z]))"
    r"|(?<=(?-i:[A-Z]))(?=(?-i:[A-Z])(?-i:[a-z])))"
    r"(?P<kw>" + _SECRET_KEYWORDS + r"|pass)(?![A-Za-z0-9])",
    re.IGNORECASE,
)
# Keywords whose value is a run of digits, such as a PIN or a one-time code.
_NUMERIC_SECRET_KEYWORD_RE = re.compile(
    r"one[ -]time (?:code|pin)|pin code|pincode|pin|otp|verification code|security code|"
    r"cvv|cvc",
    re.IGNORECASE,
)
# A bare value after a keyword: digit groups separated by single spaces, or else a run of
# characters with no space, quote, angle bracket or square bracket. A quote inside the run
# counts only when a letter or digit follows it, as in Tr0ub'4dor, and a placeholder such as
# [NAME] may sit inside it. A parenthesis belongs to the run; a closing one at its end is
# left out (see _TRAILING_PUNCTUATION).
_SECRET_DIGIT_GROUPS_RE = re.compile(r"\d{2,}(?:[ ]\d+){1,4}(?![0-9A-Za-z-])")
_SECRET_RUN_RE = re.compile(
    r"(?:(?-i:\[[A-Z]+\])|['\"\u201c\u201d](?=[^\W_])|[^\s\"'<>\u201c\u201d])+",
    re.IGNORECASE,
)
# A quoted value, which may hold spaces, up to its closing quote on the same line. A quote
# inside the value may be escaped with a backslash. A longer value is not read, which bounds
# the work done for each keyword.
_SECRET_QUOTED_RE = re.compile(r"(?P<q>[\"'])(?P<body>(?:\\.|[^\n\\]){1,4096}?)(?P=q)")
# A curly double quotation, which may hold spaces, up to its closing curly quote.
_SECRET_CURLY_QUOTED_RE = re.compile(
    r"\u201c(?P<body>[^\u201c\u201d\n]{1,4096}?)\u201d"
)
# A quote escaped with a backslash, as in JSON inside a string. The value ends at the next
# escaped quote of the same kind.
_SECRET_ESCAPED_QUOTED_RE = re.compile(
    r"\\(?P<q>[\"'])(?P<body>[^\n]{1,4096}?)\\(?P=q)"
)
# The word after a keyword that says a value follows. It must be a whole word, so "island" is not
# read as "is".
_SECRET_CONNECTOR_RE = re.compile(r"(?:is|was|are)(?![A-Za-z0-9])", re.IGNORECASE)
# Punctuation that ends a sentence, and a closing parenthesis or square bracket, are not kept as
# part of a value.
_TRAILING_PUNCTUATION = ".,;:!?)]"
# A placeholder such as [NAME], written in capitals. It is kept as it is.
_PLACEHOLDER_RE = re.compile(r"\[[A-Z]+\]")


def _has_symbol(value: str) -> bool:
    # An apostrophe, as in doesn't, is not a symbol: it is common in ordinary words.
    return any(
        not ch.isalnum() and not ch.isspace() and ch not in "'\u2019" for ch in value
    )


def _looks_secret(
    keyword: str, strong: bool, length: int, digits: int, symbol: bool
) -> bool:
    """Whether the value after a keyword is a secret, and not ordinary words.

    The value is described by its length, its digits and whether it holds a symbol, so that a
    long run is not read in full. A strong separator, such as a colon, an equals sign or a
    quote, accepts any value of four or more characters. A weak one, a space or a word such as
    "is", needs a digit, a symbol, or twelve or more characters, so that "reset my password
    please" is kept.
    """
    if _NUMERIC_SECRET_KEYWORD_RE.fullmatch(keyword):
        if digits > 10:
            # A long run of digits is a card number, which the card rule handles.
            return False
        minimum = 3 if keyword.lower() in ("cvv", "cvc", "security code") else 4
    else:
        minimum = 4
    if length < minimum:
        return False
    if strong:
        return True
    return digits > 0 or symbol or length >= 12


def _looks_secret_text(keyword: str, strong: bool, value: str) -> bool:
    """Whether a quoted value is a secret. Such a value is short enough to read in full."""
    digits = sum(ch.isdecimal() for ch in value)
    return _looks_secret(keyword, strong, len(value), digits, _has_symbol(value))


def _looks_secret_span(
    keyword: str, strong: bool, text: str, start: int, end: int, digits: int
) -> bool:
    """Whether the unquoted value ``text[start:end]`` is a secret, given its digit count."""
    length = end - start
    # A symbol matters only in a short value. A longer one passes on its length.
    symbol = length < 12 and _has_symbol(text[start:end])
    return _looks_secret(keyword, strong, length, digits, symbol)


def _skip_space(text: str, pos: int) -> int:
    while pos < len(text) and text[pos].isspace():
        pos += 1
    return pos


def _quote_index(text: str, i: int) -> int:
    """The index of the quote mark at ``i``, which may be escaped with a backslash, or -1."""
    if i < len(text) and text[i] == "\\":
        i += 1
    return i if i < len(text) and text[i] in "\"'\u201c" else -1


def _strong_separator_end(text: str, i: int) -> int | None:
    """Where the value after the strong separator at ``i`` starts, or None if there is none."""
    if text[i : i + 2] in ("=>", "->"):
        return _skip_space(text, i + 2)
    if i < len(text) and text[i] in ":=>":
        return _skip_space(text, i + 1)
    return None


_CLOSERS = {'"': '"', "'": "'", "\u201c": "\u201d"}


def _closing_quote(text: str, i: int) -> int:
    """The index of a closing quote at ``i``, straight or curly, which may be escaped, or -1."""
    if i < len(text) and text[i] == "\\":
        i += 1
    return i if i < len(text) and text[i] in "\"'\u201d" else -1


def _opening_quote(text: str, keyword_start: int) -> str | None:
    """The quote that opens the phrase around a keyword, as in "Admin password", or None."""
    k = keyword_start - 1
    while k >= 0 and k >= keyword_start - 64:
        ch = text[k]
        if ch == "\n":
            return None
        if ch in "\"'\u201c" and (k == 0 or not text[k - 1].isalnum()):
            return ch
        k -= 1
    return None


def _opens_quoted_value(text: str, quote: int) -> bool:
    """Whether a quote after a space, with no opening quote before its keyword, opens a value.

    It does when a closing quote of the same kind follows on the same line and no quote comes
    after the separator that follows the quote, as in pin "  :  is" and Secret " => ! correct ".
    It does not in password " => "hunter2", where the quote closes a phrase before the separator.
    """
    if text[quote] not in _CLOSERS:
        return False
    value = _strong_separator_end(text, _skip_space(text, quote + 1))
    if value is not None and value < len(text) and text[value] in "\"'“”":
        return False
    end = text.find(_CLOSERS[text[quote]], quote + 1, quote + 4097)
    return end >= 0 and "\n" not in text[quote + 1 : end]


def _secret_value_start(
    text: str, pos: int, keyword_start: int
) -> tuple[bool, int] | None:
    """Where the value after a keyword that ends at ``pos`` starts, and whether the separator
    is strong.

    A colon, an equals sign, a fat arrow, an arrow or a closing angle bracket is a strong
    separator, and it may sit between quotes, as in "password": "hunter2". A quote may be
    escaped with a backslash. The words "is", "was" and "are", and a plain space, are weak, but
    "is" or "was" followed by a colon or an equals sign is strong. Each run of spaces is skipped
    once, so a long run costs no more than its length. Returns None when no separator follows.
    """
    n = len(text)
    i = _skip_space(text, pos)
    spaced = i > pos
    opener = _opening_quote(text, keyword_start)
    quote = _closing_quote(text, i)
    j = quote + 1 if quote >= 0 else i
    # Spaces may sit before a closing bracket, as in config["password" ] =.
    bracket = _skip_space(text, j) if quote >= 0 else j
    # A subscript such as config["password"] = or params[:password] = closes with a bracket,
    # and then an equals sign.
    closed = bracket < n and text[bracket] == "]"
    if closed:
        j = bracket + 1
    after = _skip_space(text, j)
    if quote >= 0 or closed:
        if after < n and (
            text[after] == "=" or (quote >= 0 and not closed and text[after] in ":>")
        ):
            # A quote after a space, with no opening quote before its keyword, opens a value
            # such as pin "  :  is", unless a quote follows the separator.
            if not (
                quote >= 0
                and spaced
                and opener is None
                and _opens_quoted_value(text, quote)
            ):
                i = after
                spaced = True
        elif (
            quote >= 0
            and not closed
            and opener is not None
            and text[quote] == _CLOSERS[opener]
            and n > after > j
        ):
            # A quoted phrase followed by a space and a value, as in "Admin password" "hunter2".
            i = after
            spaced = True
    strong_end = _strong_separator_end(text, i)
    if strong_end is not None:
        return True, strong_end
    if not spaced:
        return None
    connector = _SECRET_CONNECTOR_RE.match(text, i)
    if connector is None:
        return False, _skip_space(text, i)
    after_connector = _skip_space(text, connector.end())
    strong_end = _strong_separator_end(text, after_connector)
    if strong_end is not None:
        return True, strong_end
    return False, after_connector


def _redact_secret_tokens(text: str, counts: Counter[str]) -> str:
    for pattern in _SECRET_TOKEN_RES:
        text, found = pattern.subn("[SECRET]", text)
        if found:
            counts["secret"] += found
    text, found = _BEARER_RE.subn(r"\g<1>[SECRET]", text)
    if found:
        counts["secret"] += found
    return text


def _redact_url_credentials(text: str, counts: Counter[str]) -> str:
    # Before the URL rule, which would cut the credentials at a ? or a # in the password.
    text, found = _URL_CREDENTIALS_RE.subn(r"\g<1>[SECRET]@", text)
    if found:
        counts["secret"] += found
    return text


class _ValueScan:
    """The unquoted values in one text, found in time linear in the length of the text.

    A value runs to the next delimiter, so one run can follow many keywords, as in pin:pin:pin:.
    The run is measured once and reused for each keyword inside it, and the digits of a value
    come from prefix sums. So a long run costs no more per keyword than a short one.
    """

    def __init__(self, text: str) -> None:
        self._text = text
        self._run_start = 0
        self._run_end = 0
        self._core_end = 0
        self._digit_prefix: list[int] | None = None

    def span(self, start: int) -> tuple[int, int]:
        """The end of the value at ``start`` before any trailing punctuation, and its end."""
        if not self._run_start <= start < self._run_end:
            match = _SECRET_RUN_RE.match(self._text, start)
            if match is None:
                return start, start
            end = match.end()
            core = end
            while core > start:
                ch = self._text[core - 1]
                if ch in ".,;:!?)" or (
                    ch == "]" and not _ends_with_placeholder(self._text, start, core)
                ):
                    core -= 1
                else:
                    break
            self._run_start, self._run_end, self._core_end = start, end, core
        return self._core_end, self._run_end

    def digits(self, start: int, end: int) -> int:
        """How many digits the text holds between ``start`` and ``end``."""
        if self._digit_prefix is None:
            prefix = [0]
            total = 0
            for ch in self._text:
                if ch.isdecimal():
                    total += 1
                prefix.append(total)
            self._digit_prefix = prefix
        return self._digit_prefix[end] - self._digit_prefix[start]


def _ends_with_placeholder(text: str, start: int, end: int) -> bool:
    """Whether text[start:end] ends with a placeholder such as [NAME], which is kept whole."""
    for opening in range(end - 2, max(start, end - 26) - 1, -1):
        if text[opening] == "[" and _PLACEHOLDER_RE.fullmatch(text, opening, end):
            return True
    return False


def _skip_openers(text: str, start: int) -> int:
    """Skip the brackets that open a value, since they enclose it rather than belong to it.

    A placeholder such as [NAME] is not skipped, since it is a placeholder in its own right.
    """
    while start < len(text) and text[start] in "([<":
        if text[start] == "[" and _PLACEHOLDER_RE.match(text, start):
            break
        start = _skip_space(text, start + 1)
    return start


def _redact_secret_keywords(text: str, counts: Counter[str]) -> str:
    pieces: list[str] = []
    last = 0
    values = _ValueScan(text)
    for match in _SECRET_KEYWORD_RE.finditer(text):
        if match.start() < last:
            continue  # the keyword sits inside a value that was just replaced
        found = _secret_value_start(text, match.end(), match.start())
        if found is None:
            continue
        strong, start = found
        keyword = match.group("kw")
        if keyword.lower() == "pass" and not strong:
            # "pass" is also a verb, as in "pass 3 people", so a space alone does not start a
            # value. A colon, an equals sign or "is" after it does.
            if _SECRET_CONNECTOR_RE.match(text, _skip_space(text, match.end())) is None:
                continue
        start = _skip_openers(text, start)
        if start >= len(text):
            continue
        opening = _quote_index(text, start)
        if opening >= 0:
            quoted = (
                _SECRET_ESCAPED_QUOTED_RE
                if text[start] == "\\"
                else _SECRET_CURLY_QUOTED_RE
                if text[start] == "\u201c"
                else _SECRET_QUOTED_RE
            ).match(text, start)
            if quoted is not None:
                body = quoted.group("body")
                # A quote glued to a word, as in is"x", may be the closing quote of a phrase, so a
                # value after it must be one word.
                glued = start > 0 and text[start - 1].isalpha()
                if (
                    not body.strip()
                    or _TOKEN_RE.fullmatch(body)
                    or (glued and any(ch.isspace() for ch in body))
                    or not _looks_secret_text(keyword, strong, body)
                ):
                    continue
                pieces.append(text[last : quoted.start("body")])
                pieces.append("[SECRET]")
                pieces.append(text[quoted.end("body") : quoted.end()])
                last = quoted.end()
                counts["secret"] += 1
                continue
            # The quote closes nothing, so the value is read from just after it.
            start = _skip_openers(text, _skip_space(text, opening + 1))
            if start >= len(text):
                continue
        digit_groups = _SECRET_DIGIT_GROUPS_RE.match(text, start)
        if digit_groups is not None:
            core_end = end = digit_groups.end()
        else:
            core_end, end = values.span(start)
        if core_end <= start:
            continue
        if _TOKEN_RE.fullmatch(text, start, core_end) or not _looks_secret_span(
            keyword, strong, text, start, core_end, values.digits(start, core_end)
        ):
            continue
        pieces.append(text[last:start])
        pieces.append("[SECRET]" + text[core_end:end])
        last = end
        counts["secret"] += 1
    if not pieces:
        return text
    pieces.append(text[last:])
    return "".join(pieces)


def ends_with_secret_keyword(text: str) -> bool:
    """Whether ``text`` ends with a keyword that introduces a secret, such as "Wi-Fi password".

    A separator may follow the keyword, as in "Wi-Fi password:". The decision export uses this
    to redact the notes of a task whose title ends that way. A bare "pass" counts only with a
    separator, since "Renew bus pass" is an ordinary task.
    """
    body = text.rstrip()
    separated = body.endswith((":", "=", "-"))
    if separated:
        body = body[:-1].rstrip()
    if re.search(
        r"(?<![A-Za-z0-9])(?:" + _SECRET_KEYWORDS + r")$", body, re.IGNORECASE
    ):
        return True
    return (
        separated
        and re.search(r"(?<![A-Za-z0-9])pass$", body, re.IGNORECASE) is not None
    )


_PERCENT_EMAIL_RE = re.compile(
    r"(?<![\w.%+-])[\w.%+-]+%40[\w-]+(?:\.[\w-]+)*\.[^\W\d_]{2,}"
)


def _redact_emails(text: str, counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        counts["email"] += 1
        end = match.end()
        if match.string[end : end + 1] == "[":
            base = _EMAIL_BASE_RE.match(match.string, match.start())
            if base is not None:
                # The path goes with the address. A short query is kept, as the bracket may
                # begin a placeholder such as [NAME]; a long one is dropped.
                tail = match.string[base.end() : end]
                query = min(
                    (tail.find(mark) for mark in "?#" if mark in tail), default=-1
                )
                if query >= 0 and _LONG_QUERY_RE.fullmatch(tail, query) is None:
                    return "[EMAIL]" + tail[query:]
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


def _lone_card_spans(text: str) -> list[tuple[int, int]]:
    """Spans of digit runs that hold one card: four groups of four digits that pass Luhn.

    Only a run of exactly four groups is taken, so a run with a phone or another card in
    it is not. A run that overlaps a dotted card is not taken either, so the card rule
    always reads the whole run.
    """
    masked = _mask_dates(text)
    dotted = [(match.start(), match.end()) for match in _DOT_CARD_RE.finditer(masked)]
    spans: list[tuple[int, int]] = []
    for run in _CARD_RUN_RE.finditer(masked):
        groups = _CARD_GROUP_RE.findall(run.group(0))
        if len(groups) != 4 or any(len(group) != 4 for group in groups):
            continue
        if not _is_card("".join(groups)):
            continue
        if any(start < run.end() and run.start() < end for start, end in dotted):
            continue
        spans.append((run.start(), run.end()))
    return spans


def _unobstructed_lone_cards(text: str) -> list[tuple[int, int]]:
    """The lone cards that no phone match only partly covers."""
    matches = [match.span() for match in _PHONE_RE.finditer(text)]
    return [
        (start, end)
        for start, end in _lone_card_spans(text)
        if not any(
            m_start < end and start < m_end and not (start <= m_start and m_end <= end)
            for m_start, m_end in matches
        )
    ]


def _phone_spans(text: str, protected: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Positions of the numbers the phone rule takes.

    A match that lies wholly inside a protected span is left for the card rule.
    """
    spans: list[tuple[int, int]] = []
    for match in _PHONE_RE.finditer(text):
        if any(
            start <= match.start() and match.end() <= end for start, end in protected
        ):
            continue
        number = _phone_span(match.group(0))
        if number is not None:
            spans.append((match.start(), match.start() + len(number)))
    return spans


def _card_spans_of(text: str) -> list[tuple[int, int]]:
    """Spans of the cards in the text. The text itself is not changed."""
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


def _blank(chars: list[str], spans: Iterable[tuple[int, int]]) -> None:
    """Overwrite each span with letters, so positions stay and no rule reads it again."""
    for start, end in spans:
        chars[start:end] = "x" * (end - start)


def _phone_card_reading(
    text: str, protect: Callable[[str], list[tuple[int, int]]]
) -> list[tuple[int, int, str]]:
    """Everything one reading hides, as (start, end, category) positions in ``text``.

    A pass takes the phones the phone rule finds when ``protect``'s spans are left to the
    card rule, then the cards in what remains. Passes repeat until one finds nothing, since
    taking one number can expose the next.
    """
    chars = list(text)
    found: list[tuple[int, int, str]] = []
    while True:
        work = "".join(chars)
        phones = _phone_spans(work, protect(work))
        _blank(chars, phones)
        cards = _card_spans_of("".join(chars))
        _blank(chars, cards)
        if not phones and not cards:
            return found
        found += [(start, end, "phone") for start, end in phones]
        found += [(start, end, "card") for start, end in cards]


def _redact_phones_and_cards(text: str, counts: Counter[str]) -> str:
    """Replace phone numbers and cards.

    The two rules compete for the same digits. A card can hold a phone-shaped run, as in
    ``4000 0000 0000 0002``, and a card next to a phone can be read as one longer card
    that leaves part of the real card behind. So the text is read two ways:

    - the lone-card reading protects only a card written alone as four groups of four
      digits, so a phone beside a card is taken first and the card is read from the rest;
    - the whole-card reading protects any phone match that lies inside a card, so the
      card rule takes a card that the phone rule would otherwise split.

    Every digit that either reading hides is hidden. A span that only the second reading
    covers is merged with the first reading's spans that it overlaps, and the merged span
    is a card when any part of it is.
    """
    first = _phone_card_reading(text, _unobstructed_lone_cards)
    second = _phone_card_reading(text, _card_spans_of)
    hidden = {index for start, end, _ in first for index in range(start, end)}
    extra = [
        span
        for span in second
        if any(
            text[index].isdigit() and index not in hidden
            for index in range(span[0], span[1])
        )
    ]
    merged: list[tuple[int, int, str]] = []
    for start, end, category in sorted(first + extra):
        if merged and start < merged[-1][1]:
            last_start, last_end, last_category = merged[-1]
            category = "card" if "card" in (last_category, category) else category
            merged[-1] = (last_start, max(last_end, end), category)
        else:
            merged.append((start, end, category))
    if not merged:
        return text
    pieces: list[str] = []
    cursor = 0
    for start, end, category in merged:
        pieces.append(text[cursor:start])
        pieces.append("[CARD]" if category == "card" else "[PHONE]")
        cursor = end
        counts[category] += 1
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
    for form in list(forms):
        for straight, curly in (("'", "’"), ("’", "'")):
            if straight in form:
                forms[form.replace(straight, curly)] = None
    return tuple(forms)


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


_UNSPACED_CLASS = "".join(
    f"\\U{low:08x}-\\U{high:08x}" for low, high in _UNSPACED_RANGES
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
            r"(?<!(?!["
            + _UNSPACED_CLASS
            + r"])\w)(?<!\w[.@])(?:"
            + _alternation(spaced)
            + r")"
            r"(?!(?![" + _UNSPACED_CLASS + r"])\w)(?!@[\w-]+\.)(?!\.(?-i:[a-z0-9]))"
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

    This is a pure helper. It keeps no state beyond its compiled name patterns, and reads no
    environment variables. Its callers are ``persona_extractor.build_tone_examples``, which is
    off unless ``HBPE_TONE_EXAMPLES_ENABLED`` is set, and
    ``PersonaDataExtractor.extract_decision_items``.
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

        The name, URL, e-mail, IBAN, phone and card rules run again on their own output
        until a pass changes nothing. Then the address rule runs once, and the others run
        again on its output, until nothing changes. The address rule runs last, so a house
        number is never taken from a phone or card that a later pass would find. The
        result is a fixed point, so redacting it a second time changes nothing. Each
        change removes at least one character that is not part of a placeholder, so the
        loop ends.
        """
        counts: Counter[str] = Counter()
        current = _normalise(text)
        while True:
            while True:
                step = self._redact_pass(current, counts)
                if step == current:
                    break
                current = step
            step = _redact_addresses(current, counts)
            if step == current:
                return current, dict(counts)
            current = step

    def _redact_pass(self, text: str, counts: Counter[str]) -> str:
        out = _redact_names(text, self._deny_pattern, self._allow_pattern, counts)
        out = _redact_url_credentials(out, counts)
        out = _redact_urls(out, counts)
        out = _redact_secret_tokens(out, counts)
        out = _redact_emails(out, counts)
        out = _redact_secret_keywords(out, counts)
        out = _redact_ibans(out, counts)
        return _redact_phones_and_cards(out, counts)
