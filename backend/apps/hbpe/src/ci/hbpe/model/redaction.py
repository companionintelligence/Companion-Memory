"""
Deterministic redaction for text that becomes tone-adapter training data.

``Redactor.redact(text)`` returns ``(redacted_text, counts)``. ``counts`` maps each
category that matched to its number of replacements, and categories with no match are
left out. The output depends only on the input and the configured names, so the same
input always gives the same output, and redacting a second time changes nothing.

Categories, in the order they are applied:

- ``url``: a URL with a query string or fragment, with credentials (``user:pass@``), or
  with a token-like path segment. The scheme, host and path are kept. The query, the
  fragment and the credentials are dropped, and a token-like path segment becomes
  ``[TOKEN]``. A plain URL with none of these is left alone.
- ``email``: email addresses become ``[EMAIL]``.
- ``iban``: IBANs that pass the ISO 13616 mod-97 check become ``[IBAN]``.
- ``phone``: numbers with a leading ``+``, North American numbers, and UK and French
  style national numbers become ``[PHONE]``. A match must carry 8 to 15 digits.
- ``card``: runs of 13 to 19 digits, optionally grouped with single spaces or hyphens,
  that pass the Luhn check become ``[CARD]``. A 14-digit run that reads as a
  ``YYYYMMDDhhmmss`` timestamp is not treated as a card.
- ``address``: a house number, one to three capitalised words and a street suffix
  (Street, Road, Avenue and so on) become ``[ADDRESS]``.
- ``name``: caller-supplied names, matched case-insensitively as whole words, become
  ``[NAME]``.

Names come in two lists. ``deny_names`` are redacted wherever they appear.
``allow_names`` are phrases that stay as written even when they contain a denied name:
``"Central Park"`` when ``"Park"`` is denied, or ``"I will"`` when ``"Will"`` is denied.
Allowed phrases are protected before denied names are looked for. A name that is on
both lists is rejected, because the intent is unclear.

Dates, times and short numbers are never redacted. Known gaps, by design: 7-digit local
phone numbers, lowercase street addresses, postcodes, and names that are not listed.
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
    # Bare host and path with a query, such as example.com/pay?x=1.
    r"|(?<![\w@.-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/[^\s<>\"'?#]*[?#][^\s<>\"']+",
    re.IGNORECASE,
)
_SCHEME_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
_TOKEN_SEGMENT_RE = re.compile(
    r"(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{20,}"
)

_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*"
    r"\.[A-Za-z]{2,}(?![A-Za-z0-9-])"
)

_IBAN_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?: ?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])"
)

_PHONE_RE = re.compile(
    r"(?<![\w+])"
    r"(?:"
    # +44 20 7946 0958, +1 (555) 123-4567, +33 6 12 34 56 78
    r"\+[0-9]{1,3}(?:[ .-]?\(?[0-9]{1,4}\)?){2,5}"
    # (555) 123-4567, 555-123-4567, 555.123.4567
    r"|(?:\([0-9]{3}\)|[0-9]{3})[ .-][0-9]{3}[ .-][0-9]{4}"
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


def _sanitise_url(raw: str) -> tuple[str, bool]:
    """Drop the query, fragment, userinfo and token-like path segments from a URL."""
    core = raw.rstrip(".,;:!?)]}")
    trailing = raw[len(core) :]
    cut = min(
        (index for index in (core.find("?"), core.find("#")) if index != -1),
        default=len(core),
    )
    changed = cut != len(core)
    head = core[:cut]
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


def _compile_name_pattern(
    deny: tuple[str, ...], allow: tuple[str, ...]
) -> re.Pattern[str] | None:
    if not deny:
        return None
    alternatives: list[str] = []
    if allow:
        alternatives.append(f"(?P<allow>{_alternation(allow)})")
    alternatives.append(f"(?P<deny>{_alternation(deny)})")
    keep = r"(?P<keep>(?-i:\[(?:" + "|".join(_TOKEN_WORDS) + r")\]))"
    body = r"(?<!\w)(?:" + "|".join(alternatives) + r")(?!\w)"
    return re.compile(keep + "|" + body, re.IGNORECASE)


def _redact_names(text: str, pattern: re.Pattern[str], counts: Counter[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        if match.group("deny") is None:
            # An allowed phrase, or a placeholder token that was already written.
            return match.group(0)
        counts["name"] += 1
        return "[NAME]"

    return pattern.sub(repl, text)


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
    """Applies the redaction rules described in the module docstring."""

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
        self._name_pattern = _compile_name_pattern(deny, allow)

    def redact(self, text: str) -> tuple[str, dict[str, int]]:
        """Return the redacted text and the number of replacements per category."""
        counts: Counter[str] = Counter()
        out = _redact_urls(text, counts)
        out = _redact_emails(out, counts)
        out = _redact_ibans(out, counts)
        out = _redact_phones(out, counts)
        out = _redact_cards(out, counts)
        out = _redact_addresses(out, counts)
        if self._name_pattern is not None:
            out = _redact_names(out, self._name_pattern, counts)
        return out, dict(counts)
