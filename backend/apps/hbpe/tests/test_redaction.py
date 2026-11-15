"""
Table-driven tests for ci.hbpe.model.redaction.

Each category has positive cases, which must be redacted, and negative cases, which
must come back unchanged. The negative cases guard against false positives: dates,
times and short numbers are never redacted. All data here is synthetic.
"""

from __future__ import annotations

import pytest

from ci.hbpe.model.redaction import CATEGORIES, Redactor

EMAIL_CASES = [
    pytest.param(
        "Write to sarah.jones@example.com today",
        "Write to [EMAIL] today",
        {"email": 1},
        id="email-plain",
    ),
    pytest.param(
        "Mail a+tag@sub.example.co.uk.",
        "Mail [EMAIL].",
        {"email": 1},
        id="email-subdomain-trailing-dot",
    ),
    pytest.param(
        "Either x@y.io or z@w.org",
        "Either [EMAIL] or [EMAIL]",
        {"email": 2},
        id="email-two-addresses",
    ),
    pytest.param(
        "Mail josé@example.com now",
        "Mail [EMAIL] now",
        {"email": 1},
        id="email-unicode-local-part",
    ),
    pytest.param(
        "Mail o'brien@example.com or first_last@example.com now",
        "Mail [EMAIL] or [EMAIL] now",
        {"email": 2},
        id="email-apostrophe-and-underscore",
    ),
    pytest.param(
        "Mail 'sarah@example.com' now",
        "Mail '[EMAIL]' now",
        {"email": 1},
        id="email-quoted-keeps-quotes",
    ),
    pytest.param(
        "Follow @sarah on social",
        "Follow @sarah on social",
        {},
        id="neg-handle-without-domain",
    ),
    pytest.param(
        "The host user@localhost is down",
        "The host user@localhost is down",
        {},
        id="neg-no-tld",
    ),
]

URL_CASES = [
    pytest.param(
        "Reset here: https://example.com/reset?token=abc123",
        "Reset here: https://example.com/reset",
        {"url": 1},
        id="url-query-dropped",
    ),
    pytest.param(
        "See https://example.com/docs/intro#setup.",
        "See https://example.com/docs/intro.",
        {"url": 1},
        id="url-fragment-dropped-sentence-dot-kept",
    ),
    pytest.param(
        "Login https://user:secret@example.com/a now",
        "Login https://example.com/a now",
        {"url": 1},
        id="url-userinfo-dropped",
    ),
    pytest.param(
        "Open https://example.com/verify/3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b now",
        "Open https://example.com/verify/[TOKEN] now",
        {"url": 1},
        id="url-token-path-segment",
    ),
    pytest.param(
        "Pay at www.example.com/pay?card=1 ok",
        "Pay at www.example.com/pay ok",
        {"url": 1},
        id="url-www-query-dropped",
    ),
    pytest.param(
        "Read example.com/faq?x=1 later",
        "Read example.com/faq later",
        {"url": 1},
        id="url-bare-host-query-dropped",
    ),
    pytest.param(
        "Reset at example.com?token=abc123 today",
        "Reset at example.com today",
        {"url": 1},
        id="url-bare-host-query-without-path",
    ),
    pytest.param(
        "Open example.com/verify/3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b now",
        "Open example.com/verify/[TOKEN] now",
        {"url": 1},
        id="url-bare-host-token-path-segment",
    ),
    pytest.param(
        "Open https://example.com/verify/3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b.#top now",
        "Open https://example.com/verify/[TOKEN]. now",
        {"url": 1},
        id="url-token-before-punctuation-and-fragment",
    ),
    pytest.param(
        "Read example.com/docs/intro later, or visit example.com today",
        "Read example.com/docs/intro later, or visit example.com today",
        {},
        id="neg-bare-host-without-query",
    ),
    pytest.param(
        "(see https://example.com/a?b=1).",
        "(see https://example.com/a).",
        {"url": 1},
        id="url-inside-brackets",
    ),
    pytest.param(
        "Plain https://example.com/docs/intro here",
        "Plain https://example.com/docs/intro here",
        {},
        id="neg-plain-url",
    ),
    pytest.param(
        "https://example.com/blog/2026-11-14-release-notes-for-the-tone-adapter-work",
        "https://example.com/blog/2026-11-14-release-notes-for-the-tone-adapter-work",
        {},
        id="neg-dated-slug-is-not-a-token",
    ),
    pytest.param(
        "Score is 3.5/10? nice",
        "Score is 3.5/10? nice",
        {},
        id="neg-score-with-question-mark",
    ),
]

IBAN_CASES = [
    pytest.param(
        "Pay GB82 WEST 1234 5698 7654 32 today",
        "Pay [IBAN] today",
        {"iban": 1},
        id="iban-spaced",
    ),
    pytest.param(
        "Send to DE89370400440532013000 soon",
        "Send to [IBAN] soon",
        {"iban": 1},
        id="iban-compact",
    ),
    pytest.param(
        "Acct gb82west12345698765432 thanks",
        "Acct [IBAN] thanks",
        {"iban": 1},
        id="iban-lowercase",
    ),
    pytest.param(
        "Pay BE68 5390 0754 7034 THAN",
        "Pay [IBAN] THAN",
        {"iban": 1},
        id="iban-followed-by-uppercase-word",
    ),
    pytest.param(
        "Use FR14 2004 1010 0505 0001 3M02 606 now",
        "Use [IBAN] now",
        {"iban": 1},
        id="iban-with-letters-in-bban",
    ),
    pytest.param(
        "Ref GB00 WEST 1234 5698 7654 32 ok",
        "Ref GB00 WEST 1234 5698 7654 32 ok",
        {},
        id="neg-bad-check-digits",
    ),
    pytest.param(
        "Code AB12 CDEF ok",
        "Code AB12 CDEF ok",
        {},
        id="neg-too-short",
    ),
]

PHONE_CASES = [
    pytest.param(
        "Call +44 20 7946 0958 after lunch",
        "Call [PHONE] after lunch",
        {"phone": 1},
        id="phone-intl-uk",
    ),
    pytest.param(
        "Dial +1 (555) 123-4567 now",
        "Dial [PHONE] now",
        {"phone": 1},
        id="phone-intl-nanp",
    ),
    pytest.param(
        "Text (555) 123-4567 or 555.123.4567",
        "Text [PHONE] or [PHONE]",
        {"phone": 2},
        id="phone-nanp-formats",
    ),
    pytest.param(
        "Call (555)123-4567 today",
        "Call [PHONE] today",
        {"phone": 1},
        id="phone-nanp-paren-no-space",
    ),
    pytest.param(
        "Call 0044 20 7946 0958 today",
        "Call [PHONE] today",
        {"phone": 1},
        id="phone-intl-00-prefix",
    ),
    pytest.param(
        "Ring 555 123 4567 soon",
        "Ring [PHONE] soon",
        {"phone": 1},
        id="phone-nanp-spaces",
    ),
    pytest.param(
        "Ring 5552345678 soon",
        "Ring [PHONE] soon",
        {"phone": 1},
        id="phone-nanp-unseparated",
    ),
    pytest.param(
        "Mobile 07700 900123 today",
        "Mobile [PHONE] today",
        {"phone": 1},
        id="phone-uk-mobile-spaced",
    ),
    pytest.param(
        "Office 020 7946 0958",
        "Office [PHONE]",
        {"phone": 1},
        id="phone-uk-landline",
    ),
    pytest.param(
        "Mobile 07700900123",
        "Mobile [PHONE]",
        {"phone": 1},
        id="phone-uk-unseparated",
    ),
    pytest.param(
        "Freephone 0800 1111 2222 today",
        "Freephone [PHONE] today",
        {"phone": 1},
        id="phone-uk-freephone",
    ),
    pytest.param(
        "Paris 06 12 34 56 78",
        "Paris [PHONE]",
        {"phone": 1},
        id="phone-fr-pairs",
    ),
    pytest.param(
        "Call +44 20 7946 0958 2026 ok",
        "Call [PHONE] 2026 ok",
        {"phone": 1},
        id="phone-trailing-number-not-swallowed",
    ),
    pytest.param(
        "Meeting on 2026-11-14 at 10:30",
        "Meeting on 2026-11-14 at 10:30",
        {},
        id="neg-iso-date-and-time",
    ),
    pytest.param(
        "Dates 01-12-2026 and 05.12.2026",
        "Dates 01-12-2026 and 05.12.2026",
        {},
        id="neg-dd-mm-yyyy-dates",
    ),
    pytest.param(
        "Stamped 01-12-2026 09:30 done",
        "Stamped 01-12-2026 09:30 done",
        {},
        id="neg-date-with-time",
    ),
    pytest.param(
        "Run 5 km at 07:30 sharp",
        "Run 5 km at 07:30 sharp",
        {},
        id="neg-short-numbers-and-time",
    ),
    pytest.param(
        "Call 555-1234 later",
        "Call 555-1234 later",
        {},
        id="neg-seven-digit-local-number",
    ),
    pytest.param(
        "Price $1,250.00 or 3.14159",
        "Price $1,250.00 or 3.14159",
        {},
        id="neg-money-and-decimals",
    ),
    pytest.param(
        "Room 204 in ZIP 94107",
        "Room 204 in ZIP 94107",
        {},
        id="neg-room-and-zip",
    ),
    pytest.param(
        "Stamped 2026-11-14T10:30:00Z",
        "Stamped 2026-11-14T10:30:00Z",
        {},
        id="neg-iso-timestamp",
    ),
]

CARD_CASES = [
    pytest.param(
        "Card 4111 1111 1111 1111 expires",
        "Card [CARD] expires",
        {"card": 1},
        id="card-spaced-visa-test-number",
    ),
    pytest.param(
        "Card 4111-1111-1111-1111.",
        "Card [CARD].",
        {"card": 1},
        id="card-hyphenated",
    ),
    pytest.param(
        "Card 4111111111111111 and 4111111111111112",
        "Card [CARD] and 4111111111111112",
        {"card": 1},
        id="card-luhn-valid-only",
    ),
    pytest.param(
        "Amex 378282246310005 ok",
        "Amex [CARD] ok",
        {"card": 1},
        id="card-15-digit",
    ),
    pytest.param(
        "Mastercard 5555 5555 5555 4444",
        "Mastercard [CARD]",
        {"card": 1},
        id="card-mastercard-test-number",
    ),
    pytest.param(
        "Card 4111 1111 1111 1112 failed",
        "Card 4111 1111 1111 1112 failed",
        {},
        id="neg-fails-luhn",
    ),
    pytest.param(
        "Order 1234 5678 9012 done",
        "Order 1234 5678 9012 done",
        {},
        id="neg-twelve-digits",
    ),
    pytest.param(
        "Stamped 20261114103009 here",
        "Stamped 20261114103009 here",
        {},
        id="neg-compact-timestamp-passes-luhn",
    ),
]

ADDRESS_CASES = [
    pytest.param(
        "Meet me at 123 Main Street tomorrow",
        "Meet me at [ADDRESS] tomorrow",
        {"address": 1},
        id="address-street",
    ),
    pytest.param(
        "I live at 221B Baker Street, London.",
        "I live at [ADDRESS], London.",
        {"address": 1},
        id="address-house-number-with-letter",
    ),
    pytest.param(
        "Drop it at 42 Elm Rd.",
        "Drop it at [ADDRESS].",
        {"address": 1},
        id="address-abbreviated-suffix-sentence-dot-kept",
    ),
    pytest.param(
        "Parking at 10 Downing St",
        "Parking at [ADDRESS]",
        {"address": 1},
        id="address-st-at-end",
    ),
    pytest.param(
        "Their office, 1600 Pennsylvania Avenue, is open",
        "Their office, [ADDRESS], is open",
        {"address": 1},
        id="address-avenue",
    ),
    pytest.param(
        "Flat 4, 12 Oak Road is ours",
        "Flat 4, [ADDRESS] is ours",
        {"address": 1},
        id="address-after-flat-number",
    ),
    pytest.param(
        "I ran 5 Road trips today",
        "I ran 5 Road trips today",
        {},
        id="neg-road-trips",
    ),
    pytest.param(
        "Chapter 3 Way Forward",
        "Chapter 3 Way Forward",
        {},
        id="neg-chapter-way-forward",
    ),
    pytest.param(
        "We scored 2 Goals",
        "We scored 2 Goals",
        {},
        id="neg-goals",
    ),
    pytest.param(
        "Version 2 Street Food",
        "Version 2 Street Food",
        {},
        id="neg-street-food",
    ),
]

NEGATIVE_NON_PII = [
    pytest.param(
        "Dates 2026-11-14, 14/11/2026, 14.11.2026; times 10:30, 1:45 pm; "
        "numbers 42, 3.14, 2026, ZIP 94107",
        "Dates 2026-11-14, 14/11/2026, 14.11.2026; times 10:30, 1:45 pm; "
        "numbers 42, 3.14, 2026, ZIP 94107",
        {},
        id="neg-dates-times-short-numbers",
    ),
    pytest.param(
        "Let's meet at 3pm on Thursday, the 14th of November 2026, in Room 204.",
        "Let's meet at 3pm on Thursday, the 14th of November 2026, in Room 204.",
        {},
        id="neg-ordinary-scheduling-sentence",
    ),
    pytest.param(
        "Booked 20261114 for lunch",
        "Booked 20261114 for lunch",
        {},
        id="neg-compact-date-eight-digits",
    ),
]


@pytest.mark.parametrize(("text", "expected", "counts"), EMAIL_CASES)
def test_email_cases(text: str, expected: str, counts: dict[str, int]) -> None:
    assert Redactor().redact(text) == (expected, counts)


@pytest.mark.parametrize(("text", "expected", "counts"), URL_CASES)
def test_url_cases(text: str, expected: str, counts: dict[str, int]) -> None:
    assert Redactor().redact(text) == (expected, counts)


@pytest.mark.parametrize(("text", "expected", "counts"), IBAN_CASES)
def test_iban_cases(text: str, expected: str, counts: dict[str, int]) -> None:
    assert Redactor().redact(text) == (expected, counts)


@pytest.mark.parametrize(("text", "expected", "counts"), PHONE_CASES)
def test_phone_cases(text: str, expected: str, counts: dict[str, int]) -> None:
    assert Redactor().redact(text) == (expected, counts)


@pytest.mark.parametrize(("text", "expected", "counts"), CARD_CASES)
def test_card_cases(text: str, expected: str, counts: dict[str, int]) -> None:
    assert Redactor().redact(text) == (expected, counts)


@pytest.mark.parametrize(("text", "expected", "counts"), ADDRESS_CASES)
def test_address_cases(text: str, expected: str, counts: dict[str, int]) -> None:
    assert Redactor().redact(text) == (expected, counts)


@pytest.mark.parametrize(("text", "expected", "counts"), NEGATIVE_NON_PII)
def test_non_pii_text_is_untouched(
    text: str, expected: str, counts: dict[str, int]
) -> None:
    assert Redactor().redact(text) == (expected, counts)


NAME_CASES = [
    pytest.param(
        "Hi SARAH, thanks",
        ["Sarah"],
        [],
        "Hi [NAME], thanks",
        {"name": 1},
        id="name-case-insensitive",
    ),
    pytest.param(
        "Anna and Ann's cat",
        ["Ann"],
        [],
        "Anna and [NAME]'s cat",
        {"name": 1},
        id="name-whole-word-only",
    ),
    pytest.param(
        "Sarah Jones and Sarah",
        ["Sarah", "Sarah Jones"],
        [],
        "[NAME] and [NAME]",
        {"name": 2},
        id="name-longest-match-first",
    ),
    pytest.param(
        "Tell O'Brien and Jean-Luc",
        ["O'Brien", "Jean-Luc"],
        [],
        "Tell [NAME] and [NAME]",
        {"name": 2},
        id="name-with-punctuation",
    ),
    pytest.param(
        "hola JOSÉ y josé",
        ["José"],
        [],
        "hola [NAME] y [NAME]",
        {"name": 2},
        id="name-unicode-case-insensitive",
    ),
    pytest.param(
        "Meet in Central Park or Park Ave",
        ["Park"],
        ["Central Park"],
        "Meet in Central Park or [NAME] Ave",
        {"name": 1},
        id="allow-phrase-protects-denied-word",
    ),
    pytest.param(
        "I will call. Will called.",
        ["Will"],
        ["I will"],
        "I will call. [NAME] called.",
        {"name": 1},
        id="allow-phrase-for-common-word",
    ),
    pytest.param(
        "[NAME] said hi, Name too",
        ["Name"],
        [],
        "[NAME] said hi, [NAME] too",
        {"name": 1},
        id="placeholder-tokens-untouched",
    ),
    pytest.param(
        "Sarahs and Sarah's coat",
        ["Sarah"],
        [],
        "Sarahs and [NAME]'s coat",
        {"name": 1},
        id="name-not-part-of-longer-word",
    ),
    pytest.param(
        "Ann Marie called, and Ann too",
        ["Ann Marie"],
        ["Ann"],
        "[NAME] called, and Ann too",
        {"name": 1},
        id="allow-does-not-protect-overlapping-denied-name",
    ),
    pytest.param(
        "Mark Twain wrote it",
        ["Mark Twain"],
        ["Mark"],
        "[NAME] wrote it",
        {"name": 1},
        id="allow-shorter-phrase-does-not-protect-longer-name",
    ),
    pytest.param(
        "Mo Ray Ban",
        ["Mo Ray"],
        ["Ray Ban"],
        "[NAME] Ban",
        {"name": 1},
        id="denied-name-sticking-out-of-allowed-phrase",
    ),
    pytest.param(
        "Ann Marie Curie called",
        ["Ann Marie"],
        ["Ann Marie Curie"],
        "Ann Marie Curie called",
        {},
        id="allowed-phrase-containing-denied-name-kept",
    ),
    pytest.param(
        "Ann Marie Curie called",
        ["Ann Marie", "Marie Curie"],
        [],
        "[NAME] called",
        {"name": 1},
        id="overlapping-denied-names-redacted-once",
    ),
    pytest.param(
        "Nothing to see",
        ["", "   "],
        [],
        "Nothing to see",
        {},
        id="blank-names-ignored",
    ),
    pytest.param(
        "Sarah",
        [],
        [],
        "Sarah",
        {},
        id="no-names-configured",
    ),
]


@pytest.mark.parametrize(("text", "deny", "allow", "expected", "counts"), NAME_CASES)
def test_name_cases(
    text: str,
    deny: list[str],
    allow: list[str],
    expected: str,
    counts: dict[str, int],
) -> None:
    redactor = Redactor(deny_names=deny, allow_names=allow)
    assert redactor.redact(text) == (expected, counts)


def test_name_on_both_lists_is_rejected() -> None:
    with pytest.raises(ValueError, match="both deny_names and allow_names"):
        Redactor(deny_names=["Sarah"], allow_names=["sarah"])


def test_name_shorter_than_two_characters_is_rejected() -> None:
    with pytest.raises(ValueError, match="at least 2 characters"):
        Redactor(deny_names=["A"])


def test_all_categories_together() -> None:
    text = (
        "Mail sarah@example.com, call +44 20 7946 0958, card 4111 1111 1111 1111, "
        "IBAN GB82 WEST 1234 5698 7654 32, live at 10 Downing Street, "
        "see https://shop.example.com/a?session=xyz, and Sarah says hi."
    )
    redacted, counts = Redactor(deny_names=["Sarah"]).redact(text)
    assert redacted == (
        "Mail [EMAIL], call [PHONE], card [CARD], IBAN [IBAN], "
        "live at [ADDRESS], see https://shop.example.com/a, and [NAME] says hi."
    )
    assert counts == {
        "url": 1,
        "email": 1,
        "iban": 1,
        "phone": 1,
        "card": 1,
        "address": 1,
        "name": 1,
    }
    assert set(counts) <= set(CATEGORIES)


@pytest.mark.parametrize(
    "text",
    [
        "Mail sarah@example.com, call +44 20 7946 0958 about 10 Downing Street",
        "Card 4111 1111 1111 1111 and IBAN GB82 WEST 1234 5698 7654 32",
        "See https://example.com/reset?token=abc123 and Sarah's notes",
        "Reset example.com?token=abc123, mail josé@example.com, call (555)123-4567",
        "Ring 0044 20 7946 0958 about Sarah's flat at Central Park, 12 Oak Road",
        "Open https://example.com/verify/3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b.#top now",
        "Booked (with Sarah) at www.example.com/x]#Oak[TOKEN][TOKEN] today",
        # Found by fuzzing: a scheme URL hidden inside a schemeless candidate.
        "12: : (--'josé,www.5,3@[RoadDowningwww.=https://:1[EMAIL]@0044555b",
    ],
)
def test_redaction_is_idempotent(text: str) -> None:
    redactor = Redactor(deny_names=["Sarah"], allow_names=["Central Park"])
    once, counts = redactor.redact(text)
    # The first pass must change this input and count what it changed. Otherwise the
    # second pass proves nothing: a redactor that returned its input unchanged would
    # pass the last assertion too.
    assert once != text
    assert counts and all(count > 0 for count in counts.values())
    assert redactor.redact(once) == (once, {})
