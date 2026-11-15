"""
Deterministic redaction for text that becomes tone-adapter training data.

``Redactor.redact(text)`` returns ``(redacted_text, counts)``. ``counts`` maps each
category that matched to its number of replacements, and categories with no match are
left out. The output depends only on the input and the configured names, so the same
input always gives the same output, and redacting a second time changes nothing.

Nothing in the runtime calls this module yet. Its only caller is
``persona_extractor.build_tone_examples``, which is off unless
``HBPE_TONE_EXAMPLES_ENABLED`` is set.

Categories, in the order they are applied:

- ``url``: a URL with a query string or fragment, with credentials (``user:pass@``), or
  with a token-like path segment. A URL is text that starts with a scheme or ``www.``,
  or a host followed by a path, query or fragment, such as ``example.com/pay?x=1``. The
  scheme, host and path are kept. The query, the fragment and the credentials are
  dropped. A path segment of at least 20 letters, digits or underscores, with both a
  letter and a digit, becomes ``[TOKEN]``. A URL with none of these is left alone.
- ``email``: an address with a dotted domain, such as ``sarah@example.com``, becomes
  ``[EMAIL]``. Letters from any script count, so ``josé@example.com`` is caught.
- ``iban``: IBANs that pass the ISO 13616 mod-97 check become ``[IBAN]``.
- ``phone``: numbers with a leading ``+`` or ``00``, North American numbers, and UK and
  French style national numbers become ``[PHONE]``. A match must carry 8 to 15 digits.
- ``card``: runs of 13 to 19 digits, optionally grouped with single spaces or hyphens,
  that pass the Luhn check become ``[CARD]``. A 14-digit run that reads as a
  ``YYYYMMDDhhmmss`` timestamp is not treated as a card.
- ``address``: a house number, one to three capitalised words and a street suffix
  (Street, Road, Avenue and so on) become ``[ADDRESS]``.
- ``name``: caller-supplied names, matched case-insensitively as whole words, become
  ``[NAME]``.

Names come in two lists. ``deny_names`` are redacted wherever they appear, including
where two denied names overlap. ``allow_names`` are phrases that stay as written when a
denied name sits wholly inside them: ``"Central Park"`` keeps ``"Park"`` when ``"Park"``
is denied, and ``"I will"`` keeps ``"Will"`` when ``"Will"`` is denied. A denied name
that only overlaps an allowed phrase is still redacted. With ``"Ann"`` allowed and
``"Ann Marie"`` denied, ``"Ann Marie"`` becomes ``[NAME]``. A name that is on both
lists is rejected, because the intent is unclear.

Dates and times in the usual separated forms are never redacted, and neither is a
number on its own with fewer than 8 digits. A bare run of 10 digits whose first and
fourth digits are 2 to 9 is read as a phone number, so a compact ``YYYYMMDDhh`` stamp can
be redacted. Known gaps, by design: 7-digit local phone numbers, lowercase street
addresses, postcodes, and names that are not listed.
"""

from __future__ import annotations

import re
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

_URL_RE = re.compile(
    r"(?<![\w@.-])(?:(?:https?|ftp)://|www\.)[^\s<>\"']+"
    # A bare host with a path, query or fragment, such as example.com/pay?x=1 or
    # example.com?token=abc. _sanitise_url decides what, if anything, to remove.
    r"|(?<![\w@.-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}"
    r"(?:/[^\s<>\"']*|[?#][^\s<>\"']+)",
    re.IGNORECASE,
)
_SCHEME_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
_TOKEN_SEGMENT_RE = re.compile(
    r"(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{20,}"
)

# Letters from any script count, and an apostrophe may sit inside a local part.
_EMAIL_RE = re.compile(
    r"(?<![\w.%+-])[\w.%+-][\w.%+'-]*@[\w-]+(?:\.[\w-]+)*"
    r"\.[^\W\d_]{2,}(?![\w-])"
)

_IBAN_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?: ?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])"
)

_PHONE_RE = re.compile(
    r"(?<![\w+])"
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
    r"(?!\w)"
)

_CARD_RE = re.compile(r"(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])")

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
    def repl(match: re.Match[str]) -> str:
        raw = match.group(0)
        digits = "".join(ch for ch in raw if ch in _DIGITS)
        if len(digits) == 14 and _is_compact_timestamp(digits):
            return raw
        if not _luhn_ok(digits):
            return raw
        counts["card"] += 1
        return "[CARD]"

    return _CARD_RE.sub(repl, text)


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


def _name_pattern(names: tuple[str, ...]) -> re.Pattern[str] | None:
    """Whole-word matches of the names, one per start position.

    The lookahead lets a match start inside another match, so overlapping names are all
    found. Group 1 holds the matched text.
    """
    if not names:
        return None
    return re.compile(
        r"(?<!\w)(?=((?:" + _alternation(names) + r")(?!\w)))", re.IGNORECASE
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
    tokens = [m.span() for m in _TOKEN_RE.finditer(text)]
    allowed = _occurrences(allow, text) if allow is not None else []
    targets = [
        (start, end)
        for start, end in _occurrences(deny, text)
        if not any(start < t_end and t_start < end for t_start, t_end in tokens)
        and not any(a_start <= start and end <= a_end for a_start, a_end in allowed)
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
        self._deny_pattern = _name_pattern(deny)
        self._allow_pattern = _name_pattern(allow)

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
        out = _redact_urls(text, counts)
        out = _redact_emails(out, counts)
        out = _redact_ibans(out, counts)
        out = _redact_phones(out, counts)
        out = _redact_cards(out, counts)
        out = _redact_addresses(out, counts)
        return _redact_names(out, self._deny_pattern, self._allow_pattern, counts)
