"""
Deterministic redaction for text that becomes tone-adapter training data.

``Redactor.redact(text)`` returns ``(redacted_text, counts)``. ``counts`` maps each
category that matched to its number of replacements, and categories with no match are
left out. The output depends only on the input and the configured names, so the same
input always gives the same output, and redacting a second time changes nothing.

Nothing in the runtime calls this module yet. Its only caller is
``persona_extractor.build_tone_examples``, which is off unless
``HBPE_TONE_EXAMPLES_ENABLED`` is set.

The rules run in the order below, and the whole set repeats until a pass changes
nothing. Names run first, so a denied name is replaced before a query or a number next
to it is removed.

- ``name``: caller-supplied names, matched case-insensitively as whole words, become
  ``[NAME]``. A name is left alone when it is followed by ``@``, or by ``.`` and a letter
  or digit, and when it is preceded by ``@`` or ``.``, so that an address or a host name
  is not broken up. Both the precomposed and the decomposed spelling of a name match.
- ``url``: a URL with a query string or fragment, with credentials (``user:pass@``), or
  with a token-like path segment. A URL is text that starts with a scheme or ``www.``,
  or with a host, optionally followed by a port, and then a path, query or fragment, such
  as ``example.com/pay?x=1``. The scheme, host and path are kept. The query, the fragment
  and the credentials are dropped. A path segment of at least 20 letters, digits or
  underscores, with both a letter and a digit, becomes ``[TOKEN]``. A query value of 20
  or more characters is always dropped. A shorter query is dropped only when no space and
  then a number, ``+``, ``(`` or a placeholder follows it. Otherwise dropping it would
  cut into that number, as in ``example.com?tel=07700 900123``, so the phone rule sees
  the whole number. A URL with none of these is left alone.
- ``email``: an address with a dotted domain, or with an IPv4 domain, such as
  ``sarah@example.com``, becomes ``[EMAIL]``, and a path or query directly after it goes
  with it. Letters from any script count, so ``josé@example.com`` is caught. An apostrophe
  in the local part is allowed only between two letters, so ``o'brien@example.com`` is
  caught whole.
- ``iban``: IBANs that pass the ISO 13616 mod-97 check become ``[IBAN]``.
- ``phone``: numbers with a leading ``+`` or ``00``, North American numbers, and UK and
  French style national numbers become ``[PHONE]``. A match must carry 8 to 15 digits. A
  number may follow a letter, so ``call07700900123`` is caught.
- ``card``: the longest run of whole digit groups that passes the Luhn check becomes
  ``[CARD]``. Groups are separated by one or two spaces (a non-breaking space counts) or
  by a hyphen. A card may also be written as four groups of four digits joined by dots.
  Separated dates and times are masked before the search, so a card never runs into one.
  Digits after the card, as in ``4111 1111 1111 1111 123``, are kept. A 14-digit
  ``YYYYMMDDhhmmss`` stamp is not treated as a card.
- ``address``: a house number, one to three capitalised words and a street suffix
  (Street, Road, Avenue and so on) become ``[ADDRESS]``.

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

Known gaps, by design: 7-digit local phone numbers, including one that follows a longer
number, lowercase street addresses, postcodes, and names that are not listed. A name
inside a host label, such as ``sarah.example.com``, is not redacted. Digits glued straight
to an address with no space, such as ``4111 1111 1111 1111sarah@example.com``, have the
glued group taken into the address, so the rest of the number stays. An IBAN glued to
letters is not matched. A product name such as ``2 Google Drive`` can match the address
rule. The userinfo of a URL whose password contains a slash is not stripped. A card
written with slashes is not recognised, and neither is a quoted local part such as
``"sarah"@example.com``. A phone number with a space after the plus sign, such as
``+ 44 20 7946 0958``, or with a bracketed zero, such as ``(0)20 7946 0958``, is not
matched. A UUID in a path is not treated as a token, because it has hyphens.
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
)
_SUFFIX_ALTERNATION = "|".join(
    re.escape(suffix) for suffix in sorted(_STREET_SUFFIXES, key=len, reverse=True)
)

# The path of a URL. It stops at "?" and "#", which start the query and the fragment.
_URL_PATH = r"(?:/[^\s<>\"'?#]*)?"
# The query or fragment of a URL, which is dropped with the URL. Two shapes are allowed.
# A value of 20 or more characters, with an optional "key=" in front, is always dropped.
# A plain key or word is dropped only when no space and then a number, "+", "(" or a
# placeholder follows it, because dropping it there would cut into that number. It is
# also kept when it ends in a digit and a capitalised word follows, as in "?q=221 Baker
# Street", where the digits belong to an address. A "[" ends the match, so a query that
# holds a placeholder such as [NAME] is kept as it is.
_URL_QUERY = (
    r"(?:[?#]"
    r"(?:(?:[A-Za-z_][\w.-]*=)?[^\s<>\"'\[]{20,}(?=[\s<>\"'\]]|$)"
    r"|[A-Za-z_][^\s<>\"'\[]*(?=[\s<>\"'\]]|$)(?!\s+(?:[0-9]{2,}|[+(\[]))"
    r"(?!(?<=[0-9])\s+(?-i:[A-Z]))"
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
    r"(?<![\w@.-])(?:(?:https?|ftp)://|www\.)[^\s<>\"'?#/]*"
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

# The local part of an address. An apostrophe is allowed only between two letters, so
# "o'brien" is one local part. A card number glued before an address ("1111'sarah") is
# not swallowed, because the apostrophe there follows a digit.
_EMAIL_LOCAL = r"(?:[\w!#$%&*+=?^{|}~.-]|(?<=[^\W\d_])'(?=[^\W\d_]))+"
# A dotted domain that ends in letters, or an IPv4 address, optionally in brackets.
_EMAIL_DOMAIN = (
    r"(?:[\w-]+(?:\.[\w-]+)*\.[^\W\d_]{2,}|\[?(?:[0-9]{1,3}\.){3}[0-9]{1,3}\]?)"
)
_EMAIL_RE = re.compile(
    # The lookbehind stops a match from starting in the middle of a longer local part.
    # Nothing follows the top-level domain except the path or query tail, so a digit or
    # a hyphen right after it does not stop the match.
    r"(?<![\w!#$%&*+=?^{|}~.-])" + _EMAIL_LOCAL + r"@" + _EMAIL_DOMAIN + _URL_TAIL
)

_IBAN_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?: ?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])"
)

_PHONE_RE = re.compile(
    r"(?<![0-9+])"
    r"(?:"
    # +44 20 7946 0958, +1 (555) 123-4567, +33 6 12 34 56 78
    r"\+[0-9]{1,3}(?:[ .-]?\(?[0-9]{1,4}\)?){2,5}"
    # 0044 20 7946 0958
    r"|00[1-9][0-9]{0,2}(?:[ .-]?\(?[0-9]{1,4}\)?){2,5}"
    # (555) 123-4567, (555)123-4567, 555-123-4567, 555.123.4567
    r"|(?:\([0-9]{3}\)[ .-]?|[0-9]{3}[ .-])[0-9]{3}[ .-][0-9]{4}"
    # 5551234567
    r"|[2-9][0-9]{2}[2-9][0-9]{6}"
    # 020 7946 0958, 0121 496 0000
    r"|0[0-9]{2,4}[ .-][0-9]{3,4}[ .-][0-9]{3,4}"
    # 01234 567890
    r"|0[0-9]{4}[ -][0-9]{6}"
    # 07700900123
    r"|0[0-9]{9,10}"
    # 06 12 34 56 78
    r"|0[0-9](?:[ .-][0-9]{2}){4}"
    r")"
    # A digit after the number would mean the match stopped in the middle of a longer run.
    r"(?![0-9])"
)

# A run of digit groups. Groups are separated by one or two spaces (a non-breaking space
# counts) or by one hyphen. Each group is a run of digits. Dots are not separators here,
# because decimals such as 3.14159 are common in ordinary text.
_CARD_RUN_RE = re.compile(r"[0-9]+(?:(?:[ \u00a0]{1,2}|-)[0-9]+)*")
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
    r"(?<![\w.])[0-9]{1,6}[A-Za-z]?\s+"
    r"(?:[A-Z][\w'’-]*\.?\s+){1,3}"
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
    compact = value.replace(" ", "").upper()
    if not 15 <= len(compact) <= 34:
        return False
    rearranged = compact[4:] + compact[:4]
    number = int("".join(str(int(ch, 36)) for ch in rearranged))
    return number % 97 == 1


def _iban_prefix(candidate: str) -> str | None:
    """Longest prefix of the candidate, ending before a space, that passes mod-97."""
    ends = [index for index, ch in enumerate(candidate) if ch == " "]
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


def _find_cards(
    groups: list[tuple[int, int, str]], found: list[tuple[int, int]]
) -> None:
    """Record the longest Luhn-valid run of whole digit groups, then search either side.

    ``groups`` holds ``(start, end, digits)`` for each digit group, in order. The longest
    valid run wins, and of two runs of equal length the one further left. Digits on either
    side of the card are searched again, so two cards in one run are both found.
    """
    best: tuple[int, int, int] | None = None
    for i in range(len(groups)):
        total = 0
        for j in range(i, len(groups)):
            total += len(groups[j][2])
            if total > 19:
                break
            if total >= 13 and (best is None or total > best[0]):
                if _is_card("".join(group[2] for group in groups[i : j + 1])):
                    best = (total, i, j)
    if best is None:
        return
    _, i, j = best
    found.append((groups[i][0], groups[j][1]))
    _find_cards(groups[:i], found)
    _find_cards(groups[j + 1 :], found)


def _redact_urls(text: str, counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        cleaned, changed = _sanitise_url(match.group(0))
        if changed:
            counts["url"] += 1
        return cleaned

    return _URL_RE.sub(repl, text)


def _redact_emails(text: str, counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        counts["email"] += 1
        return "[EMAIL]"

    return _EMAIL_RE.sub(repl, text)


def _redact_ibans(text: str, counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        candidate = match.group(0)
        prefix = _iban_prefix(candidate)
        if prefix is None:
            return candidate
        counts["iban"] += 1
        return "[IBAN]" + candidate[len(prefix) :]

    return _IBAN_RE.sub(repl, text)


def _redact_phones(text: str, counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        candidate = match.group(0)
        span = _phone_span(candidate)
        if span is None:
            return candidate
        counts["phone"] += 1
        return "[PHONE]" + candidate[len(span) :]

    return _PHONE_RE.sub(repl, text)


def _redact_cards(text: str, counts: Counter[str]) -> str:
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
        _find_cards(groups, found)
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
    """Add the precomposed and the decomposed spelling of each name, so either matches."""
    forms: dict[str, None] = {}
    for name in names:
        for form in ("NFC", "NFD"):
            forms[unicodedata.normalize(form, name)] = None
    return tuple(forms)


def _name_pattern(names: tuple[str, ...]) -> re.Pattern[str] | None:
    """Whole-word matches of the names, one per start position.

    A match is skipped when it is preceded by "@" or "." (inside an address or a host
    name), or when it is followed by "@", or by "." and a letter or digit. The lookahead
    lets a match start inside another match, so overlapping names are all found. Group 1
    holds the matched text.
    """
    if not names:
        return None
    return re.compile(
        r"(?<![\w.@])(?=((?:" + _alternation(names) + r")(?!\w)(?!@)(?!\.[^\W_])))",
        re.IGNORECASE,
    )


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
        name = " ".join(raw.split())
        if not name:
            continue
        if len(name) < 2:
            raise ValueError(f"{field} entry {raw!r} must be at least 2 characters")
        cleaned[name] = None
    return tuple(cleaned)


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
        current = text
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
