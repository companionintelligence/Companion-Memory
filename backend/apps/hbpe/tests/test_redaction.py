"""
Table-driven tests for ci.hbpe.model.redaction.

Each category has positive cases, which must be redacted, and negative cases, which
must come back unchanged. The negative cases guard against false positives: dates,
times and short numbers are never redacted. All data here is synthetic.
"""

from __future__ import annotations

import time

import pytest

from ci.hbpe.model.redaction import CATEGORIES, Redactor, ends_with_secret_keyword

# PEM markers are built at run time, so no key header appears in this source file.
_DASHES = "-" * 5


def _pem_marker(kind: str) -> str:
    return f"{_DASHES}{kind}{_DASHES}"


# A base64 body that decodes to plain text ("fake-key-body"), so no key material is in the source.
_FAKE_BODY = "ZmFrZS1rZXktYm9keQ=="


# A Stripe-style live key built at run time, so the source holds no key-shaped literal.
_STRIPE_LIVE_KEY = "sk" + "_live_" + "0123456789abcdefghijklmn"


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
        id="email-apostrophe-inside-local-part",
    ),
    pytest.param(
        "Mail sarah@example.com07700900123 now",
        "Mail [EMAIL][PHONE] now",
        {"email": 1, "phone": 1},
        id="email-digits-glued-after-tld",
    ),
    pytest.param(
        "Mail sarah@example.com-or-call now",
        "Mail [EMAIL]-or-call now",
        {"email": 1},
        id="email-hyphen-after-tld",
    ),
    pytest.param(
        "Mail sarah!x@example.com now",
        "Mail [EMAIL] now",
        {"email": 1},
        id="email-local-part-with-punctuation",
    ),
    pytest.param(
        "Mail sarah@192.168.0.1 now",
        "Mail [EMAIL] now",
        {"email": 1},
        id="email-ip-literal-domain",
    ),
    pytest.param(
        "Mail sarah@example.com_backup now",
        "Mail [EMAIL]_backup now",
        {"email": 1},
        id="email-underscore-after-tld",
    ),
    pytest.param(
        "Mail sarah@example.com_ now",
        "Mail [EMAIL]_ now",
        {"email": 1},
        id="email-underscore-after-tld-at-end",
    ),
    pytest.param(
        "Card 4111 1111 1111 1111'sarah@example.com now",
        "Card [CARD]'[EMAIL] now",
        {"card": 1, "email": 1},
        id="email-does-not-absorb-card-before-apostrophe",
    ),
    pytest.param(
        "Mail sarah@example.com?token=3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b now",
        "Mail [EMAIL] now",
        {"email": 1},
        id="email-query-token-goes-with-address",
    ),
    pytest.param(
        "Mail sarah@example.com/verify/3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b now",
        "Mail [EMAIL] now",
        {"email": 1},
        id="email-path-token-goes-with-address",
    ),
    pytest.param(
        "Mail sarah@example.com?ref=4111 1111 1111 1111 now",
        "Mail [EMAIL]?ref=[CARD] now",
        {"email": 1, "card": 1},
        id="email-query-with-card-keeps-card-redacted",
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
    pytest.param(
        "Card 4111 1111 1111 1111!sarah@example.com now",
        "Card [CARD]![EMAIL] now",
        {"card": 1, "email": 1},
        id="email-after-exclamation-mark-after-card",
    ),
    pytest.param(
        "Mail josé@example.com today",
        "Mail [EMAIL] today",
        {"email": 1},
        id="email-decomposed-local-part",
    ),
    pytest.param(
        "Mail sarah＠example.com today",
        "Mail [EMAIL] today",
        {"email": 1},
        id="email-full-width-at-sign",
    ),
    pytest.param(
        "Mail sarah@example.c now",
        "Mail sarah@example.c now",
        {},
        id="neg-top-level-domain-of-one-letter",
    ),
    pytest.param(
        "Open mailto:sarah%40example.com today",
        "Open mailto:[EMAIL] today",
        {"email": 1},
        id="email-percent-encoded-in-mailto",
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
        {"url": 1, "secret": 1},
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
    pytest.param(
        "Connect postgres://app:s3cret@db.example.com:5432/prod now",
        "Connect postgres://db.example.com:5432/prod now",
        {"url": 1, "secret": 1},
        id="url-credentials-any-scheme",
    ),
    pytest.param(
        "Use redis://:pw123@cache:6379/0 and ssh://deploy:key@host/x",
        "Use redis://cache:6379/0 and ssh://host/x",
        {"url": 2, "secret": 2},
        id="url-credentials-redis-and-ssh",
    ),
    pytest.param(
        "Open https://example.com/verify/abcdefghijklmnopqrs1 now",
        "Open https://example.com/verify/[TOKEN] now",
        {"url": 1},
        id="path-token-of-twenty-characters",
    ),
    pytest.param(
        "Open https://example.com/verify/abcdefghijklmnopqr1 now",
        "Open https://example.com/verify/abcdefghijklmnopqr1 now",
        {},
        id="neg-path-segment-of-nineteen-characters",
    ),
    pytest.param(
        "See https://example.com/item?12345 now",
        "See https://example.com/item now",
        {"url": 1},
        id="url-digits-only-short-query-is-dropped",
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
    pytest.param(
        "Pay GB82WEST12345698765432abc now",
        "Pay [IBAN]abc now",
        {"iban": 1},
        id="iban-glued-to-letters",
    ),
    pytest.param(
        "DE89 3704 0044 0532 0130 00 DE89 3704 0044 0532 0130 00",
        "[IBAN] [IBAN]",
        {"iban": 2},
        id="iban-two-in-a-row",
    ),
    pytest.param(
        "Pay GB82-WEST-1234-5698-7654-32 now",
        "Pay [IBAN] now",
        {"iban": 1},
        id="iban-hyphen-separators",
    ),
    pytest.param(
        "Pay GB82  WEST 1234 5698 7654 32 now",
        "Pay [IBAN] now",
        {"iban": 1},
        id="iban-double-space-separators",
    ),
    pytest.param(
        "Pay XQ97WEST123456987654 today",
        "Pay [IBAN] today",
        {"iban": 1},
        id="iban-of-unlisted-country-is-redacted-by-prefix",
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
        "Call me on07700900123 now",
        "Call me on[PHONE] now",
        {"phone": 1},
        id="phone-glued-after-letters",
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
    pytest.param(
        "電話番号は０７０－１２３４－５６７８です",
        "電話番号は[PHONE]です",
        {"phone": 1},
        id="phone-full-width-digits-and-hyphens",
    ),
    pytest.param(
        "٠٧٧٠٠٩٠٠١٢٣",
        "[PHONE]",
        {"phone": 1},
        id="phone-arabic-indic-digits",
    ),
    pytest.param(
        "Call 1 212 555 0198 now",
        "Call [PHONE] now",
        {"phone": 1},
        id="phone-north-american-with-leading-one",
    ),
    pytest.param(
        "Chat https://wa.me/447700900123 now",
        "Chat https://wa.me/[PHONE] now",
        {"phone": 1},
        id="phone-in-whatsapp-link",
    ),
    pytest.param(
        "Open 07700900 123 now",
        "Open [PHONE] now",
        {"phone": 1},
        id="phone-zero-led-in-two-groups",
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
    pytest.param(
        "Card 4111 1111 1111 1111 123 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-security-code-after-card-is-included",
    ),
    pytest.param(
        "Use 2 4111 1111 1111 1111 now",
        "Use 2 [CARD] now",
        {"card": 1},
        id="card-leading-number-is-not-joined",
    ),
    pytest.param(
        "Card 4111 1111 1111 1111 10:30 now",
        "Card [CARD] 10:30 now",
        {"card": 1},
        id="card-before-time-is-kept",
    ),
    pytest.param(
        "Ref 8689688 2010-03-02 done",
        "Ref 8689688 2010-03-02 done",
        {},
        id="neg-card-not-read-across-date",
    ),
    pytest.param(
        "Card 4111 1111 1111 1111 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-non-breaking-space-separators",
    ),
    pytest.param(
        "Card 4111  1111  1111  1111 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-double-space-separators",
    ),
    pytest.param(
        "Card 4111.1111.1111.1111 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-dot-separators",
    ),
    pytest.param(
        "Card 4111\t1111\t1111\t1111 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-tab-separators",
    ),
    pytest.param(
        "Ref 4000000000000000006 ok",
        "Ref [CARD] ok",
        {"card": 1},
        id="card-nineteen-digits-luhn-valid",
    ),
    pytest.param(
        "Ref 4000 0000 0002 ok",
        "Ref 4000 0000 0002 ok",
        {},
        id="neg-twelve-digits-are-not-a-card",
    ),
    pytest.param(
        "Card 4111111111111111123 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-glued-security-code-is-included",
    ),
    pytest.param(
        "Card 4111   1111   1111   1111 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-three-space-separators",
    ),
    pytest.param(
        "Card 4000 0000 0000 0002 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-zero-led-groups-are-not-a-phone",
    ),
    pytest.param(
        "Card 4111 0234 5678 9015 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-second-zero-led-example",
    ),
    pytest.param(
        "Card 4000-0000-0000-0002 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-zero-led-hyphen-groups",
    ),
    pytest.param(
        "Card 4000.0000.0000.0002 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-zero-led-dotted-groups",
    ),
    pytest.param(
        "paid 5105 1051 0510 5100 100.00 EUR",
        "paid [CARD].00 EUR",
        {"card": 1},
        id="card-zero-led-groups-before-an-amount",
    ),
    pytest.param(
        "4000 0000 0000 0002 100.00 EUR",
        "[CARD].00 EUR",
        {"card": 1},
        id="card-zero-led-tail-before-an-amount",
    ),
    pytest.param(
        "4000 0566 5566 5556 555-123-4567",
        "[CARD] [PHONE]",
        {"card": 1, "phone": 1},
        id="card-zero-led-groups-followed-by-phone",
    ),
    pytest.param(
        "328036 0002432535",
        "[CARD]",
        {"card": 1},
        id="long-card-with-a-zero-led-phone-shaped-tail",
    ),
    pytest.param(
        "97894567 8859164111",
        "[CARD]",
        {"card": 1},
        id="long-card-with-a-north-american-looking-tail",
    ),
    pytest.param(
        "4567432535 978962-7007432535now",
        "[PHONE] [CARD]now",
        {"card": 1, "phone": 1},
        id="phone-then-long-card-with-a-phone-shaped-tail",
    ),
    pytest.param(
        "Card 4111 1111 1111 1111 555-123-4567 now",
        "Card [CARD] [PHONE] now",
        {"card": 1, "phone": 1},
        id="card-followed-by-phone-keeps-the-card-whole",
    ),
    pytest.param(
        "Tel 06 48 62 25 88 4801 7007 2418 4070 Thanks",
        "Tel [PHONE] [CARD] Thanks",
        {"card": 1, "phone": 1},
        id="phone-followed-by-card-keeps-the-card-whole",
    ),
    pytest.param(
        "+0000 0000 0000 0000.0000 4111 0046 0046",
        "[PHONE] [PHONE] [PHONE]",
        {"phone": 3},
        id="phone-straddling-two-adjacent-cards-keeps-both-hidden",
    ),
    pytest.param(
        "+8210 0564 3189 0046.0002 0753 0768 0462",
        "[PHONE] [PHONE] [PHONE]",
        {"phone": 3},
        id="phone-straddling-a-card-and-the-next-group-stays-hidden",
    ),
    pytest.param(
        "005 3976 0420 4819 6-936-918-8994 now",
        "[CARD] now",
        {"card": 1},
        id="phone-starting-inside-a-run-is-fully-hidden",
    ),
    pytest.param(
        "Card 41111111111111111226 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-glued-four-digit-security-code",
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
    pytest.param(
        "Live at 10 Very Big Old Oak Road today",
        "Live at 10 Very Big Old Oak Road today",
        {},
        id="neg-four-capitalised-words-are-not-an-address",
    ),
    pytest.param(
        "I just bought a 2 TB Hard Drive for my photos.",
        "I just bought a 2 TB Hard Drive for my photos.",
        {},
        id="neg-storage-unit-before-drive-is-not-an-address",
    ),
    pytest.param(
        "The 500 GB SSD Drive works with my laptop.",
        "The 500 GB SSD Drive works with my laptop.",
        {},
        id="neg-memory-unit-before-drive-is-not-an-address",
    ),
    pytest.param(
        "Visit 42 Wallaby Way today",
        "Visit [ADDRESS] today",
        {"address": 1},
        id="address-way-suffix",
    ),
    pytest.param(
        "Visit 10, Downing Street today",
        "Visit [ADDRESS] today",
        {"address": 1},
        id="address-comma-after-house-number",
    ),
    pytest.param(
        "Visit 221-B Baker Street today",
        "Visit [ADDRESS] today",
        {"address": 1},
        id="address-hyphenated-letter-house-number",
    ),
    pytest.param(
        "Visit 12 Élysée Road today",
        "Visit [ADDRESS] today",
        {"address": 1},
        id="address-accented-capital",
    ),
    pytest.param(
        "Meet at 12-14 Main Street.",
        "Meet at [ADDRESS].",
        {"address": 1},
        id="address-house-number-range",
    ),
    pytest.param(
        "2831 0123 7430 0207+0207 946 0958-41 Station Circle0491-6264-7184 6744.Call\t+15/03/2024\t",
        "2831 [PHONE][PHONE] Station Circle[PHONE] 6744.Call\t+15/03/2024\t",
        {"phone": 3},
        id="phone-split-by-a-new-suffix-stays-hidden",
    ),
    pytest.param(
        "Visit 5 Old Circle today.",
        "Visit [ADDRESS] today.",
        {"address": 1},
        id="address-circle-suffix",
    ),
    pytest.param(
        "Meet at 4 Station Plaza.",
        "Meet at [ADDRESS].",
        {"address": 1},
        id="address-plaza-suffix",
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

# A query or fragment glued to a host or path must not cut into a phone, card or
# address that follows it. The rules for those run on the whole number.
QUERY_GLUE_CASES = [
    pytest.param(
        "Visit example.com?+44 20 7946 0958 today",
        "Visit example.com?[PHONE] today",
        {"phone": 1},
        id="glue-phone-after-question-mark",
    ),
    pytest.param(
        "Visit example.com?4111 1111 1111 1111 today",
        "Visit example.com?[CARD] today",
        {"card": 1},
        id="glue-card-after-question-mark",
    ),
    pytest.param(
        "Visit example.com?ref=4111 1111 1111 1111 today",
        "Visit example.com?ref=[CARD] today",
        {"card": 1},
        id="glue-card-after-query-value",
    ),
    pytest.param(
        "Reset at example.com#10 Downing Street today",
        "Reset at example.com#[ADDRESS] today",
        {"address": 1},
        id="glue-house-number-after-hash",
    ),
    pytest.param(
        "See example.com/pay?+44 20 7946 0958 now",
        "See example.com/pay?[PHONE] now",
        {"phone": 1},
        id="glue-phone-after-path-and-question-mark",
    ),
    pytest.param(
        "Reach example.com?jones 4111 1111 1111 1111",
        "Reach example.com?jones [CARD]",
        {"card": 1},
        id="glue-card-after-query-word-and-space",
    ),
    pytest.param(
        "Open https://example.com/?4111 1111 1111 1111 now",
        "Open https://example.com/?[CARD] now",
        {"card": 1},
        id="glue-card-after-scheme-url-question-mark",
    ),
    pytest.param(
        "Pay example.com?ref=abc 2 times",
        "Pay example.com 2 times",
        {"url": 1},
        id="query-followed-by-short-number-is-dropped",
    ),
    pytest.param(
        "Go to example.com?token=3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b now",
        "Go to example.com now",
        {"url": 1},
        id="query-token-is-dropped",
    ),
    pytest.param(
        "Open example.com:8080/?token=3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b now",
        "Open example.com:8080/ now",
        {"url": 1},
        id="url-port-token-is-dropped",
    ),
    pytest.param(
        "Go to example.com?token=3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b 2026 next",
        "Go to example.com 2026 next",
        {"url": 1},
        id="query-token-before-number-is-dropped",
    ),
    pytest.param(
        "Open https://example.com/?tel=07700 900123 now",
        "Open https://example.com/?tel=[PHONE] now",
        {"phone": 1},
        id="query-phone-split-is-left-for-phone-rule",
    ),
    pytest.param(
        "Map https://maps.example.com/?q=221 Baker Street today",
        "Map https://maps.example.com/?q=[ADDRESS] today",
        {"address": 1},
        id="query-house-number-is-left-for-address-rule",
    ),
    pytest.param(
        "Pay example.com?ref=abc 12 34 times",
        "Pay example.com?ref=abc 12 34 times",
        {},
        id="query-before-two-digit-groups-is-kept",
    ),
    pytest.param(
        "Pay example.com?ref=abc 12 times",
        "Pay example.com 12 times",
        {"url": 1},
        id="query-before-single-number-is-dropped",
    ),
    pytest.param(
        "Pay example.com?ref=abc later",
        "Pay example.com later",
        {"url": 1},
        id="query-before-word-is-dropped",
    ),
    pytest.param(
        "Use example.com?code=8f3a2c 15 min",
        "Use example.com 15 min",
        {"url": 1},
        id="query-short-code-before-number-is-dropped",
    ),
    pytest.param(
        "Reset at example.com?code=8f3a2c (valid 15 min) now",
        "Reset at example.com (valid 15 min) now",
        {"url": 1},
        id="query-short-code-before-remark-is-dropped",
    ),
    pytest.param(
        "Call example.com?x=abc (555) 123-4567",
        "Call example.com?x=abc [PHONE]",
        {"phone": 1},
        id="query-before-bracketed-phone-is-kept",
    ),
    pytest.param(
        "Dial example.com?x=abc +44 20 7946 0958",
        "Dial example.com?x=abc [PHONE]",
        {"phone": 1},
        id="query-before-international-phone-is-kept",
    ),
    pytest.param(
        "Go to example.com?token=abcdefghijklmnopqrst 12 34 next",
        "Go to example.com 12 34 next",
        {"url": 1},
        id="token-of-twenty-characters-is-dropped-before-groups",
    ),
    pytest.param(
        "Go to example.com?ref=abcdefghijklmnopqrs 12 34 next",
        "Go to example.com?ref=abcdefghijklmnopqrs 12 34 next",
        {},
        id="short-value-before-two-groups-is-kept",
    ),
    pytest.param(
        "Ref https://example.com/?ref=40K4LpE5h5M9 Thanks for it",
        "Ref https://example.com/ Thanks for it",
        {"url": 1},
        id="query-token-ending-in-digit-before-word-is-dropped",
    ),
    pytest.param(
        "Open https://example.com/?9Xk2mQ7p now",
        "Open https://example.com/ now",
        {"url": 1},
        id="query-plain-value-starting-with-digit-is-dropped",
    ),
    pytest.param(
        "Go to example.com?token=abcdefghijklmnopqrs 12 34 next",
        "Go to example.com?token=[SECRET] 12 34 next",
        {"secret": 1},
        id="secret-token-before-two-groups-is-redacted",
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


@pytest.mark.parametrize(("text", "expected", "counts"), QUERY_GLUE_CASES)
def test_query_glue_cases(text: str, expected: str, counts: dict[str, int]) -> None:
    assert Redactor().redact(text) == (expected, counts)


SECRET_CASES = [
    pytest.param(
        "password: Tr0ub4dor&3",
        "password: [SECRET]",
        {"secret": 1},
        id="password-after-colon",
    ),
    pytest.param(
        "my PIN is 482193", "my PIN is [SECRET]", {"secret": 1}, id="pin-after-is"
    ),
    pytest.param(
        "Tell Ricky to send the PIN 482193",
        "Tell Ricky to send the PIN [SECRET]",
        {"secret": 1},
        id="pin-after-a-space",
    ),
    pytest.param(
        "api_key=sk_live_EXAMPLEKEY1234567890 in the config",
        "api_key=[SECRET] in the config",
        {"secret": 1},
        id="api-key-after-equals",
    ),
    pytest.param(
        "apikey=AKIAEXAMPLE1234567890 in the note",
        "apikey=[SECRET] in the note",
        {"secret": 1},
        id="apikey-with-a-key-looking-value",
    ),
    pytest.param(
        '{"password": "hunter2"}',
        '{"password": "[SECRET]"}',
        {"secret": 1},
        id="json-password",
    ),
    pytest.param(
        "cvv 123 on the card",
        "cvv [SECRET] on the card",
        {"secret": 1},
        id="cvv-three-digits",
    ),
    pytest.param(
        "verification code 482 193 for the bank",
        "verification code [SECRET] for the bank",
        {"secret": 1},
        id="verification-code-with-a-space",
    ),
    pytest.param(
        "one-time password 739211 expires soon",
        "one-time password [SECRET] expires soon",
        {"secret": 1},
        id="one-time-password",
    ),
    pytest.param(
        "the wifi password is correcthorsebatterystaple",
        "the wifi password is [SECRET]",
        {"secret": 1},
        id="long-passphrase-after-is",
    ),
    pytest.param(
        "password Tr0ub4dor",
        "password [SECRET]",
        {"secret": 1},
        id="password-with-a-digit",
    ),
    pytest.param(
        "token=3f9c2a7b1d4e8f6a0c5b9d2e",
        "token=[SECRET]",
        {"secret": 1},
        id="bare-token-assignment",
    ),
    pytest.param(
        "key AKIAIOSFODNN7EXAMPLE shared",
        "key [SECRET] shared",
        {"secret": 1},
        id="aws-access-key-id",
    ),
    pytest.param(
        f"stripe {_STRIPE_LIVE_KEY} here",
        "stripe [SECRET] here",
        {"secret": 1},
        id="stripe-live-key",
    ),
    pytest.param(
        "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234 is the token",
        "[SECRET] is the token",
        {"secret": 1},
        id="github-token",
    ),
    pytest.param(
        "xoxb-1234567890-abcdefghij posted",
        "[SECRET] posted",
        {"secret": 1},
        id="slack-token",
    ),
    pytest.param(
        "key AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY ok",
        "key [SECRET] ok",
        {"secret": 1},
        id="google-api-key",
    ),
    pytest.param(
        "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dGVzdHNpZw here",
        "auth [SECRET] here",
        {"secret": 1},
        id="json-web-token",
    ),
    pytest.param(
        f"{_pem_marker('BEGIN RSA PRIVATE KEY')}\n{_FAKE_BODY}\n{_pem_marker('END RSA PRIVATE KEY')}\nthanks",
        "[SECRET]\nthanks",
        {"secret": 1},
        id="private-key-block",
    ),
    pytest.param(
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 ok",
        "Authorization: Bearer [SECRET] ok",
        {"secret": 1},
        id="bearer-token",
    ),
    pytest.param(
        "password: [SECRET]",
        "password: [SECRET]",
        {},
        id="placeholder-is-not-replaced-again",
    ),
    pytest.param(
        "I need to reset my password please",
        "I need to reset my password please",
        {},
        id="reset-password-is-not-a-secret",
    ),
    pytest.param(
        "my password is ready",
        "my password is ready",
        {},
        id="password-is-ready-is-not-a-secret",
    ),
    pytest.param(
        "pin 2 inches", "pin 2 inches", {}, id="pin-measurement-is-not-a-secret"
    ),
    pytest.param(
        "token ring network", "token ring network", {}, id="token-ring-is-not-a-secret"
    ),
    pytest.param(
        "the secret santa is on Friday",
        "the secret santa is on Friday",
        {},
        id="secret-santa-is-not-a-secret",
    ),
    pytest.param(
        "Your verification code will expire soon",
        "Your verification code will expire soon",
        {},
        id="code-will-expire-is-not-a-secret",
    ),
    pytest.param(
        "tokens: 5 left", "tokens: 5 left", {}, id="tokens-plural-is-not-a-secret"
    ),
    pytest.param(
        "password 1 of 3", "password 1 of 3", {}, id="short-number-after-password"
    ),
    pytest.param("PIN 12", "PIN 12", {}, id="short-pin-is-not-a-secret"),
    pytest.param(
        "password reset: see the link below",
        "password reset: see the link below",
        {},
        id="short-word-after-colon-is-kept",
    ),
    pytest.param(
        f"Your PEM file is invalid: the error says '{_pem_marker('BEGIN PRIVATE KEY')} header missing'. Can you check your key file?",
        "Your PEM file is invalid: the error says '[SECRET] header missing'. Can you check your key file?",
        {"secret": 1},
        id="pem-without-end-keeps-the-question",
    ),
    pytest.param(
        f"My export failed with this key:\n{_pem_marker('BEGIN RSA PRIVATE KEY')}\n{_FAKE_BODY}\nCan you tell me why the export failed?",
        "My export failed with this key:\n[SECRET]\nCan you tell me why the export failed?",
        {"secret": 1},
        id="pem-body-then-question",
    ),
    pytest.param(
        f"x\r\n{_pem_marker('BEGIN PRIVATE KEY')}\r\n{_FAKE_BODY}\r\n{_pem_marker('END PRIVATE KEY')}\r\nthanks",
        "x\r\n[SECRET]\r\nthanks",
        {"secret": 1},
        id="pem-complete-block-with-crlf",
    ),
    pytest.param(
        "clientSecret: x9Yp2Lm8QzRt4Vw7",
        "clientSecret: [SECRET]",
        {"secret": 1},
        id="camel-client-secret",
    ),
    pytest.param(
        "my clientApiKey: x9Yp2Lm8QzRt4Vw7 for the app",
        "my clientApiKey: [SECRET] for the app",
        {"secret": 1},
        id="camel-client-api-key-mid-text",
    ),
    pytest.param(
        '{"refreshToken": "x9Yp2Lm8QzRt4Vw7"}',
        '{"refreshToken": "[SECRET]"}',
        {"secret": 1},
        id="camel-refresh-token-in-json",
    ),
    pytest.param(
        "dbPassword=hunter2x9",
        "dbPassword=[SECRET]",
        {"secret": 1},
        id="camel-db-password-equals",
    ),
    pytest.param(
        "oauth2Token: abc123def456",
        "oauth2Token: [SECRET]",
        {"secret": 1},
        id="camel-after-a-digit",
    ),
    pytest.param(
        "APIToken: x9Yp2Lm8QzRt4Vw7",
        "APIToken: [SECRET]",
        {"secret": 1},
        id="camel-after-an-acronym",
    ),
    pytest.param(
        "userPin: 482193",
        "userPin: [SECRET]",
        {"secret": 1},
        id="camel-user-pin",
    ),
    pytest.param(
        "smsOtp: 739211",
        "smsOtp: [SECRET]",
        {"secret": 1},
        id="camel-sms-otp",
    ),
    pytest.param(
        "Chopin: 1848 works",
        "Chopin: 1848 works",
        {},
        id="not-a-secret-chopin",
    ),
    pytest.param(
        "spin 2024 times",
        "spin 2024 times",
        {},
        id="not-a-secret-spin",
    ),
    pytest.param(
        "SPIN 2024 times",
        "SPIN 2024 times",
        {},
        id="not-a-secret-capital-spin",
    ),
    pytest.param(
        "PIN: 1234Sarah",
        "PIN: [SECRET]",
        {"secret": 1},
        id="glued-pin-letters",
    ),
    pytest.param(
        "PIN 1234abc",
        "PIN [SECRET]",
        {"secret": 1},
        id="glued-pin-space-letters",
    ),
    pytest.param(
        "otp: 482913abc",
        "otp: [SECRET]",
        {"secret": 1},
        id="glued-otp-letters",
    ),
    pytest.param(
        "security code 4821-xk9p",
        "security code [SECRET]",
        {"secret": 1},
        id="security-code-with-a-hyphen",
    ),
    pytest.param(
        "Use one-time code A7K9Q2 to sign in.",
        "Use one-time code [SECRET] to sign in.",
        {"secret": 1},
        id="one-time-code-alphanumeric",
    ),
    pytest.param(
        "PIN 4111 1111 1111 1111",
        "PIN [CARD]",
        {"card": 1},
        id="pin-followed-by-a-card-number",
    ),
    pytest.param(
        'password: "correct horse battery"',
        'password: "[SECRET]"',
        {"secret": 1},
        id="quoted-passphrase-after-colon",
    ),
    pytest.param(
        "the password is 'correct horse battery staple'",
        "the password is '[SECRET]'",
        {"secret": 1},
        id="quoted-passphrase-after-is",
    ),
    pytest.param(
        'password "reset"',
        'password "reset"',
        {},
        id="quoted-reset-is-not-a-secret",
    ),
    pytest.param(
        "password => hunter2",
        "password => [SECRET]",
        {"secret": 1},
        id="fat-arrow-separator",
    ),
    pytest.param(
        "password -> hunter2",
        "password -> [SECRET]",
        {"secret": 1},
        id="arrow-separator",
    ),
    pytest.param(
        "<password>hunter2</password>",
        "<password>[SECRET]</password>",
        {"secret": 1},
        id="xml-tag-keyword",
    ),
    pytest.param(
        "passwords: hunter2",
        "passwords: [SECRET]",
        {"secret": 1},
        id="plural-passwords",
    ),
    pytest.param(
        "https://user:pa?ss@db.example.com/x",
        "https://db.example.com/x",
        {"url": 1, "secret": 1},
        id="url-password-with-question-mark",
    ),
    pytest.param(
        "mypassword=hunter22xyz",
        "mypassword=hunter22xyz",
        {},
        id="known-gap-squashed-key-is-kept",
    ),
    pytest.param(
        "password - hunter2",
        "password - hunter2",
        {},
        id="known-gap-spaced-dash-is-kept",
    ),
    pytest.param(
        "password: correct horse battery",
        "password: [SECRET] horse battery",
        {"secret": 1},
        id="known-gap-unquoted-passphrase-keeps-the-rest",
    ),
    pytest.param(
        "wifi pass: 12345678",
        "wifi pass: [SECRET]",
        {"secret": 1},
        id="pass-after-colon",
    ),
    pytest.param(
        "the wifi pass is 12345678",
        "the wifi pass is [SECRET]",
        {"secret": 1},
        id="pass-after-is",
    ),
    pytest.param(
        "I will pass 3 people and the pass is closed",
        "I will pass 3 people and the pass is closed",
        {},
        id="pass-as-a-verb-or-before-a-word-is-kept",
    ),
    pytest.param(
        "bypass: 1234",
        "bypass: 1234",
        {},
        id="pass-inside-a-word-is-kept",
    ),
    pytest.param(
        "Wi-Fi passphrase: correcthorsebatterystaple",
        "Wi-Fi passphrase: [SECRET]",
        {"secret": 1},
        id="passphrase-after-colon",
    ),
    pytest.param(
        "pass code: 4321 for the gate",
        "pass code: [SECRET] for the gate",
        {"secret": 1},
        id="pass-code-after-colon",
    ),
    pytest.param(
        "Gate pass-code 4321",
        "Gate pass-code [SECRET]",
        {"secret": 1},
        id="pass-code-with-a-dash-after-a-space",
    ),
    pytest.param(
        "wifi pass 12345678",
        "wifi pass 12345678",
        {},
        id="known-gap-bare-pass-with-a-space-is-kept",
    ),
    pytest.param(
        "1https://admin:Tr0ub4dor&3@db.example.com/x",
        "1https://admin:[SECRET]@db.example.com/x",
        {"secret": 1},
        id="url-password-after-a-digit-glued-scheme",
    ),
    pytest.param(
        "1https://app:[SECRET]@db.example.com/x",
        "1https://app:[SECRET]@db.example.com/x",
        {},
        id="url-placeholder-password-is-not-counted-again",
    ),
    pytest.param(
        "The wifi password is: Tr0ub4dor&3",
        "The wifi password is: [SECRET]",
        {"secret": 1},
        id="connector-is-followed-by-a-colon-is-strong",
    ),
    pytest.param(
        "The wifi password is=Tr0ub4dor&3",
        "The wifi password is=[SECRET]",
        {"secret": 1},
        id="connector-is-followed-by-an-equals-sign",
    ),
    pytest.param(
        "The password was: hunter2 today",
        "The password was: [SECRET] today",
        {"secret": 1},
        id="connector-was-followed-by-a-colon",
    ),
    pytest.param(
        "pass is: 1234",
        "pass is: [SECRET]",
        {"secret": 1},
        id="pass-with-a-connector-and-a-colon",
    ),
    pytest.param(
        "the password island is closed",
        "the password island is closed",
        {},
        id="connector-must-be-a-whole-word",
    ),
    pytest.param(
        r"{\"user\":\"ci\",\"password\":\"Tr0ub4dor&3\",\"host\":\"db\"}",
        r"{\"user\":\"ci\",\"password\":\"[SECRET]\",\"host\":\"db\"}",
        {"secret": 1},
        id="escaped-quotes-in-json-inside-a-string",
    ),
    pytest.param(
        r'{"password": \"Tr0ub4dor&3\"}',
        r'{"password": \"[SECRET]\"}',
        {"secret": 1},
        id="escaped-quoted-value-after-a-plain-key",
    ),
    pytest.param(
        'password: "' + "Tr0ub4dor&3" * 100 + '"',
        'password: "[SECRET]"',
        {"secret": 1},
        id="long-quoted-passphrase-is-redacted",
    ),
    pytest.param(
        'password: "' + "k" * 5000 + '"',
        'password: "[SECRET]"',
        {"secret": 1},
        id="quoted-value-over-4096-with-no-space-is-redacted",
    ),
    pytest.param(
        'password: "' + "word " * 1000 + '"',
        'password: "[SECRET]' + " word" * 999 + ' "',
        {"secret": 1},
        id="known-gap-quoted-value-over-4096-stops-at-first-word",
    ),
    pytest.param(
        "The token is well-known",
        "The token is [SECRET]",
        {"secret": 1},
        id="over-redaction-hyphenated-word-after-is",
    ),
    pytest.param(
        "Boarding pass: Gate",
        "Boarding pass: [SECRET]",
        {"secret": 1},
        id="over-redaction-word-after-a-strong-separator",
    ),
    pytest.param(
        '{"password": "Tr0ub\\"ador&3"}',
        '{"password": "[SECRET]"}',
        {"secret": 1},
        id="escaped-quote-inside-a-quoted-value",
    ),
    pytest.param(
        'password: "hunter2 and more',
        'password: "[SECRET] and more',
        {"secret": 1},
        id="unclosed-quote-reads-the-value-after-it",
    ),
    pytest.param(
        "password is (Tr0ub4dor&3)",
        "password is ([SECRET])",
        {"secret": 1},
        id="parenthesis-before-a-value-is-kept",
    ),
    pytest.param(
        "password: [hunter2]",
        "password: [[SECRET]]",
        {"secret": 1},
        id="square-bracket-before-a-word-is-kept",
    ),
    pytest.param(
        "password: [NAME]",
        "password: [NAME]",
        {},
        id="placeholder-after-a-keyword-is-kept",
    ),
    pytest.param(
        "password is <Tr0ub4dor&3>",
        "password is <[SECRET]>",
        {"secret": 1},
        id="angle-bracket-before-a-value-is-kept",
    ),
    pytest.param(
        "password: Tr0ub'4dor&3",
        "password: [SECRET]",
        {"secret": 1},
        id="apostrophe-inside-a-bare-value",
    ),
    pytest.param(
        "password is Tr0ub(4dor&3)",
        "password is [SECRET])",
        {"secret": 1},
        id="parenthesis-inside-a-bare-value",
    ),
    pytest.param(
        'The memo quoted "the password is" and then the team agreed, which was "approved" later.',
        'The memo quoted "the password is" and then the team agreed, which was "approved" later.',
        {},
        id="connector-glued-to-a-closing-quote-is-prose",
    ),
    pytest.param(
        'He wrote "the password is" and the pin is "4321" for the door.',
        'He wrote "the password is" and the pin is "[SECRET]" for the door.',
        {"secret": 1},
        id="pin-after-prose-quotes-is-redacted",
    ),
    pytest.param(
        'She typed password is"Tr0ub4dor&3" yesterday.',
        'She typed password is"[SECRET]" yesterday.',
        {"secret": 1},
        id="connector-glued-to-a-quoted-secret",
    ),
    pytest.param(
        'password: "[Tr0ub4dor&3]',
        'password: "[[SECRET]]',
        {"secret": 1},
        id="square-bracket-after-an-unclosed-quote",
    ),
    pytest.param(
        "password: l'été2024",
        "password: [SECRET]",
        {"secret": 1},
        id="apostrophe-before-a-non-ascii-letter",
    ),
    pytest.param(
        "password: Tr0ub'éz9Q",
        "password: [SECRET]",
        {"secret": 1},
        id="apostrophe-before-a-non-ascii-letter-in-a-run",
    ),
    pytest.param(
        "password Tr0ub'4dor",
        "password [SECRET]",
        {"secret": 1},
        id="apostrophe-inside-a-weak-value-with-a-digit",
    ),
    pytest.param(
        "Your password isn't working",
        "Your password isn't working",
        {},
        id="contraction-isnt-after-a-keyword-is-prose",
    ),
    pytest.param(
        "The password doesn't match",
        "The password doesn't match",
        {},
        id="contraction-doesnt-after-a-keyword-is-prose",
    ),
    pytest.param(
        "My PIN can't be used",
        "My PIN can't be used",
        {},
        id="contraction-cant-after-a-keyword-is-prose",
    ),
    pytest.param(
        "https://example.com/reset?1QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo= thanks",
        "https://example.com/reset thanks",
        {"url": 1},
        id="digit-led-query-with-padding-is-dropped",
    ),
    pytest.param(
        "https://example.com/reset?QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=[NAME]",
        "https://example.com/reset[NAME]",
        {"url": 1},
        id="padded-query-before-a-bracket-is-dropped",
    ),
    pytest.param(
        "https://example.com/reset?9Xk2mQ7p[NAME]",
        "https://example.com/reset[NAME]",
        {"url": 1},
        id="digit-led-token-before-a-bracket-is-dropped",
    ),
    pytest.param(
        "Note: ada@example.org/9Xk2mQ7pLq3Rz8Vt5Yw1?tab=2[1] end",
        "Note: [EMAIL]?tab=2[1] end",
        {"email": 1},
        id="path-after-an-address-goes-before-a-bracket",
    ),
    pytest.param(
        "Note: ada@example.org/x?abcdefghijklmnopqrstuvwxyz0123[1] end",
        "Note: [EMAIL][1] end",
        {"email": 1},
        id="long-query-after-a-path-before-a-bracket-is-dropped",
    ),
    pytest.param(
        "sarah@example.com?QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=[NAME]",
        "[EMAIL][NAME]",
        {"email": 1},
        id="padded-query-after-an-address-before-a-bracket-is-dropped",
    ),
    pytest.param(
        "password: Pa[ss]word9",
        "password: [SECRET]",
        {"secret": 1},
        id="square-brackets-inside-a-bare-value",
    ),
    pytest.param(
        "Wi-Fi password: Sunshine[7]Park",
        "Wi-Fi password: [SECRET]",
        {"secret": 1},
        id="square-bracket-digits-inside-a-bare-value",
    ),
    pytest.param(
        'config["password"] = "Tr0ub4dor"',
        'config["password"] = "[SECRET]"',
        {"secret": 1},
        id="subscript-assignment-with-quotes",
    ),
    pytest.param(
        "params[:password] = Tr0ub4dor",
        "params[:password] = [SECRET]",
        {"secret": 1},
        id="subscript-assignment-bare",
    ),
    pytest.param(
        "Open https://app.example.com/#/verify?code=Zq8Lw3Rt7Vn2Bx9Kd4Mh6Pj1Qs5Tu0Wy now",
        "Open https://app.example.com/ now",
        {"url": 1},
        id="fragment-route-with-a-long-value-is-dropped",
    ),
    pytest.param(
        "Mail user@example.com?2fa=Zq8Lw3Rt7Vn2Bx9Kd4Mh6Pj1Qs5Tu0Wy now",
        "Mail [EMAIL] now",
        {"email": 1},
        id="digit-led-key-after-an-address-is-dropped",
    ),
    pytest.param(
        "Open https://x.com/?a[b]=Zq8Lw3Rt7Vn2Bx9Kd4Mh6Pj1Qs5Tu0Wy now",
        "Open https://x.com/ now",
        {"url": 1},
        id="bracketed-query-key-is-dropped",
    ),
    pytest.param(
        "Mail user@example.com/p#x?y=Zq8Lw3Rt7Vn2Bx9Kd4Mh6Pj1Qs5Tu0Wy[NAME] now",
        "Mail [EMAIL][NAME] now",
        {"email": 1},
        id="fragment-after-an-address-before-a-bracket-is-dropped",
    ),
    pytest.param(
        "password: Pa<ss>word9",
        "password: Pa<ss>word9",
        {},
        id="known-gap-angle-bracket-ends-a-bare-value",
    ),
    pytest.param(
        "<password>hunter2</password>",
        "<password>[SECRET]</password>",
        {"secret": 1},
        id="xml-tag-value-is-redacted",
    ),
    pytest.param(
        "the [password] is weak",
        "the [password] is weak",
        {},
        id="keyword-inside-brackets-is-prose",
    ),
    pytest.param(
        '"password" "correct horse 9"',
        '"password" "[SECRET]"',
        {"secret": 1},
        id="keyvalues-quoted-keyword-then-quoted-value",
    ),
    pytest.param(
        '"pin" "4821"',
        '"pin" "[SECRET]"',
        {"secret": 1},
        id="keyvalues-quoted-pin",
    ),
    pytest.param(
        'He said "password" twice',
        'He said "password" twice',
        {},
        id="quoted-keyword-in-prose-is-kept",
    ),
    pytest.param(
        "Wi-Fi password: “Sunny-Lake 4821”",
        "Wi-Fi password: “[SECRET]”",
        {"secret": 1},
        id="curly-double-quotes-redact-the-passphrase",
    ),
    pytest.param(
        'See https://x.com/?token="Q9xK2mZp4LwR7tYc3VbNqW8e" now',
        "See https://x.com/ now",
        {"url": 1},
        id="quoted-query-value-is-dropped",
    ),
    pytest.param(
        'Mail sarah@example.com?token="Q9xK2mZp4LwR7tYc3VbNqW8e" now',
        "Mail [EMAIL] now",
        {"email": 1},
        id="quoted-query-value-after-an-address-is-dropped",
    ),
    pytest.param(
        "https://example.com/?" + "a" * 65 + "=abcdefghijklmnopqrstuvwxyz 12 34",
        "https://example.com/ 12 34",
        {"url": 1},
        id="key-of-65-characters-is-read",
    ),
    pytest.param(
        "[TOKEN]: reviewers agreed on the fix.",
        "[TOKEN]: reviewers agreed on the fix.",
        {},
        id="closing-bracket-then-colon-is-not-a-separator",
    ),
    pytest.param(
        "“password”: hunter2",
        "“password”: [SECRET]",
        {"secret": 1},
        id="curly-quoted-keyword-then-colon",
    ),
    pytest.param(
        "“password” “correct horse 9”",
        "“password” “[SECRET]”",
        {"secret": 1},
        id="curly-quoted-keyword-then-curly-value",
    ),
    pytest.param(
        'config[ "password" ] = hunter2',
        'config[ "password" ] = [SECRET]',
        {"secret": 1},
        id="subscript-with-spaces-before-the-bracket",
    ),
    pytest.param(
        'config[ "password" ] = "hunter2"',
        'config[ "password" ] = "[SECRET]"',
        {"secret": 1},
        id="subscript-quoted-value-with-spaces",
    ),
    pytest.param(
        'see https://x.com/?token="AbCdEfGhIjKlMnOpQrStUvWx".',
        "see https://x.com/.",
        {"url": 1},
        id="quoted-query-value-before-punctuation-is-dropped",
    ),
    pytest.param(
        "Open https://x.com/?token=Xk9mQ2pL7rT4vB8nW1yZ'Jf3hD6sG0aK5eUwQ2xR7tY9 now",
        "Open https://x.com/ now",
        {"url": 1},
        id="apostrophe-inside-a-query-value-is-dropped",
    ),
    pytest.param(
        "password: pa”ss9word",
        "password: [SECRET]",
        {"secret": 1},
        id="curly-quote-inside-a-bare-value",
    ),
    pytest.param(
        "All staff passwords' 90-day rotation is mandatory.",
        "All staff passwords' 90-day rotation is mandatory.",
        {},
        id="possessive-apostrophe-after-a-keyword-is-prose",
    ),
    pytest.param(
        '{"db-password": "hunter2"}',
        '{"db-password": "[SECRET]"}',
        {"secret": 1},
        id="quoted-key-with-a-hyphen",
    ),
    pytest.param(
        '"password" hunter2',
        '"password" [SECRET]',
        {"secret": 1},
        id="quoted-keyword-then-a-space-and-value",
    ),
    pytest.param(
        '{"Admin password": "Zq7mW2xLp9"}',
        '{"Admin password": "[SECRET]"}',
        {"secret": 1},
        id="quoted-multi-word-key-then-colon",
    ),
    pytest.param(
        '{"Admin\tpassword": "Zq7mW2xLp9"}',
        '{"Admin\tpassword": "[SECRET]"}',
        {"secret": 1},
        id="quoted-key-with-a-tab-before-the-keyword",
    ),
    pytest.param(
        '"rcon password"\t"Zq7mW2xLp9"',
        '"rcon password"\t"[SECRET]"',
        {"secret": 1},
        id="valve-quoted-key-then-tab-and-value",
    ),
    pytest.param(
        '<entry key="password">Zq7mW2xLp9</entry>',
        '<entry key="password">[SECRET]</entry>',
        {"secret": 1},
        id="xml-key-with-a-closing-bracket",
    ),
    pytest.param(
        '{"Wi-Fi password": "hunter2"}',
        '{"Wi-Fi password": "[SECRET]"}',
        {"secret": 1},
        id="quoted-hyphenated-multi-word-key",
    ),
    pytest.param(
        'He said "hi" and the passwords\' 90-day rotation',
        'He said "hi" and the passwords\' 90-day rotation',
        {},
        id="possessive-apostrophe-after-an-earlier-quote-is-prose",
    ),
    pytest.param(
        "see sarah@example.com/o'neil?sig=Zq8Lp2Rt7Vw3Nb5Kd9Mf end",
        "see [EMAIL] end",
        {"email": 1},
        id="apostrophe-in-an-address-path-goes-with-the-address",
    ),
    pytest.param(
        "see https://example.com/cb?1" + "a" * 255 + "=Zq8Lp2Rt7Vw3Nb5Kd9Mf end",
        "see https://example.com/cb end",
        {"url": 1},
        id="key-of-256-characters-then-a-long-value-is-dropped",
    ),
    pytest.param(
        "see https://example.com/cb?1" + "a" * 256 + "=Zq8Lp2Rt7Vw3Nb5Kd9Mf end",
        "see https://example.com/cb end",
        {"url": 1},
        id="key-of-257-characters-then-a-long-value-is-dropped",
    ),
    pytest.param(
        "see https://example.com/cb?abcdefghijklmnopqrstuvwxyz=Zq8Lp2Rt7Vw3 end",
        "see https://example.com/cb end",
        {"url": 1},
        id="key-less-run-then-a-long-keyed-value-is-dropped",
    ),
    pytest.param(
        "https://example.com/?abcdefghijklmnopqrstuvwxyz?abc 555 1234 5678",
        "https://example.com/ 555 1234 5678",
        {"url": 1},
        id="key-less-value-with-a-question-mark-before-numbers-is-dropped",
    ),
    pytest.param(
        'pin "  :   is  password (020) " pass was',
        'pin "[SECRET]" pass was',
        {"secret": 1},
        id="spaced-quote-then-a-separator-opens-the-value",
    ),
    pytest.param(
        'Secret " => ! correct " PIN',
        'Secret "[SECRET]" PIN',
        {"secret": 1},
        id="spaced-quote-then-a-fat-arrow-opens-the-value",
    ),
    pytest.param(
        'password "=Zq8Lp2Rt7Vw3Nb5Kd9Mf"',
        'password "[SECRET]"',
        {"secret": 1},
        id="spaced-quote-with-an-equals-sign-inside-the-value",
    ),
    pytest.param(
        'password " => "hunter2"',
        'password " => "[SECRET]"',
        {"secret": 1},
        id="spaced-quote-that-closes-before-a-quoted-value",
    ),
    pytest.param(
        'Secret"=Secretpwd@',
        'Secret"=[SECRET]',
        {"secret": 1},
        id="closing-quote-then-equals-with-no-opening-quote",
    ),
]


@pytest.mark.parametrize(("text", "expected", "counts"), SECRET_CASES)
def test_secret_cases(text: str, expected: str, counts: dict[str, int]) -> None:
    assert Redactor().redact(text) == (expected, counts)


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        pytest.param("Wi-Fi password", True, id="password-at-the-end"),
        pytest.param("Wi-Fi password:", True, id="password-with-a-colon"),
        pytest.param("Wi-Fi passphrase", True, id="passphrase-at-the-end"),
        pytest.param("Wi-Fi pass:", True, id="bare-pass-with-a-colon"),
        pytest.param("Buy a PIN", True, id="pin-at-the-end"),
        pytest.param("Renew bus pass", False, id="bare-pass-at-the-end-is-kept"),
        pytest.param(
            "Pin the map to the wall", False, id="keyword-in-the-middle-is-kept"
        ),
    ],
)
def test_ends_with_secret_keyword(title: str, expected: bool) -> None:
    assert ends_with_secret_keyword(title) is expected


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
        "Open https://example.com/?name=Sarah Jones now",
        ["Sarah Jones"],
        [],
        "Open https://example.com/?name=[NAME] now",
        {"name": 1},
        id="name-inside-query-is-redacted-whole",
    ),
    pytest.param(
        "Mail sarah@example.com?x=Sarah Jones now",
        ["Sarah Jones"],
        [],
        "Mail [EMAIL]?x=[NAME] now",
        {"email": 1, "name": 1},
        id="name-after-address-query-is-redacted-whole",
    ),
    pytest.param(
        "Ask sarah@example.com about it",
        ["Sarah"],
        [],
        "Ask [EMAIL] about it",
        {"email": 1},
        id="name-inside-address-is-not-split",
    ),
    pytest.param(
        "José and José",
        ["José"],
        [],
        "[NAME] and [NAME]",
        {"name": 2},
        id="name-matches-decomposed-spelling",
    ),
    pytest.param(
        "Sarah",
        [],
        [],
        "Sarah",
        {},
        id="no-names-configured",
    ),
    pytest.param(
        "Booked for 2 Ann Lane Smith",
        ["Ann", "Smith"],
        [],
        "Booked for 2 [NAME] Lane [NAME]",
        {"name": 2},
        id="name-inside-address-and-surname-each-redacted",
    ),
    pytest.param(
        "José and José",
        ["José"],
        [],
        "[NAME] and [NAME]",
        {"name": 2},
        id="name-decomposed-deny-matches-precomposed-text",
    ),
    pytest.param(
        "田中さんに連絡してください",
        ["田中"],
        [],
        "[NAME]さんに連絡してください",
        {"name": 1},
        id="name-unspaced-script-matched-inside-text",
    ),
    pytest.param(
        "Hi @Sarah, can you check the file?",
        ["Sarah"],
        [],
        "Hi @[NAME], can you check the file?",
        {"name": 1},
        id="name-after-at-sign-is-a-mention",
    ),
    pytest.param(
        "Thanks Sarah.Will send it tomorrow",
        ["Sarah"],
        [],
        "Thanks [NAME].Will send it tomorrow",
        {"name": 1},
        id="name-before-capitalised-word-without-space",
    ),
    pytest.param(
        "Ping Sarah@ when free",
        ["Sarah"],
        [],
        "Ping [NAME]@ when free",
        {"name": 1},
        id="name-before-at-sign-without-domain",
    ),
    pytest.param(
        "Frau GROSSMANN wohnt hier",
        ["Großmann"],
        [],
        "Frau [NAME] wohnt hier",
        {"name": 1},
        id="name-german-sharp-s-matches-ss",
    ),
    pytest.param(
        "Hi.Sarah, thanks a lot",
        ["Sarah"],
        [],
        "Hi.Sarah, thanks a lot",
        {},
        id="known-gap-name-after-dot-is-kept",
    ),
    pytest.param(
        "李明说你好",
        ["李明"],
        [],
        "[NAME]说你好",
        {"name": 1},
        id="name-han-name-before-han-text",
    ),
    pytest.param(
        "Chat Sarahさんに連絡",
        ["Sarah"],
        [],
        "Chat [NAME]さんに連絡",
        {"name": 1},
        id="name-beside-unspaced-script-is-a-whole-word",
    ),
    pytest.param(
        "O’Brien and O'Brien",
        ["O'Brien"],
        [],
        "[NAME] and [NAME]",
        {"name": 2},
        id="name-curly-apostrophe-matches-straight",
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


# Each input is redacted to a known output, and a second pass over that output changes
# nothing. The expected outputs were checked by hand.
IDEMPOTENCE_CASES = [
    pytest.param(
        "Mail sarah@example.com, call +44 20 7946 0958 about 10 Downing Street",
        "Mail [EMAIL], call [PHONE] about [ADDRESS]",
        id="mixed-contact-and-address",
    ),
    pytest.param(
        "Card 4111 1111 1111 1111 and IBAN GB82 WEST 1234 5698 7654 32",
        "Card [CARD] and IBAN [IBAN]",
        id="card-and-iban",
    ),
    pytest.param(
        "See https://example.com/reset?token=abc123 and Sarah's notes",
        "See https://example.com/reset and [NAME]'s notes",
        id="url-query-and-name",
    ),
    pytest.param(
        "Reset example.com?token=abc123, mail josé@example.com, call (555)123-4567",
        "Reset example.com, mail [EMAIL], call [PHONE]",
        id="bare-host-query-email-and-phone",
    ),
    pytest.param(
        "Ring 0044 20 7946 0958 about Sarah's flat at Central Park, 12 Oak Road",
        "Ring [PHONE] about [NAME]'s flat at Central Park, [ADDRESS]",
        id="allowed-phrase-kept",
    ),
    pytest.param(
        "Open https://example.com/verify/3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b.#top now",
        "Open https://example.com/verify/[TOKEN]. now",
        id="token-segment-before-punctuation",
    ),
    pytest.param(
        "Booked (with Sarah) at www.example.com/x]#Oak[TOKEN][TOKEN] today",
        "Booked (with [NAME]) at www.example.com/x]#Oak[TOKEN][TOKEN] today",
        id="placeholders-are-not-redacted-again",
    ),
    pytest.param(
        "12: : (--'josé,www.5,3@[RoadDowningwww.=https://:1[EMAIL]@0044555b",
        "12: : (--'josé,[RoadDowningwww.=https://0044555b",
        id="fuzz-scheme-url-inside-schemeless-candidate",
    ),
    pytest.param(
        "Visit example.com?ref=4111 1111 1111 1111 or mail "
        "sarah@example.com/verify/3f9c2a7b1d4e8f6a0c5b9d2e7f1a4c8b",
        "Visit example.com?ref=[CARD] or mail [EMAIL]",
        id="query-card-and-email-path-token",
    ),
    pytest.param(
        "Card 4111 1111 1111 1111'sarah@example.com?x=1 and example.com?+44 20 7946 0958",
        "Card [CARD]'[EMAIL] and example.com?[PHONE]",
        id="card-glued-to-email-and-phone-after-query",
    ),
    pytest.param(
        "Wi-Fi pass is 12345678 and I will pass 3 people",
        "Wi-Fi pass is [SECRET] and I will pass 3 people",
        id="pass-after-is-redacted-and-a-verb-kept",
    ),
    pytest.param(
        "Join 1https://admin:Tr0ub4dor&3@db.example.com/x now",
        "Join 1https://admin:[SECRET]@db.example.com/x now",
        id="digit-glued-url-password-redacted-once",
    ),
    pytest.param(
        "password is (Tr0ub4dor&3)",
        "password is ([SECRET])",
        id="parenthesis-value-is-stable",
    ),
    pytest.param(
        "<password>hunter2</password>",
        "<password>[SECRET]</password>",
        id="xml-value-is-stable",
    ),
    pytest.param(
        "password: Pa[ss]word9 and Wi-Fi password: Sunshine[7]Park",
        "password: [SECRET] and Wi-Fi password: [SECRET]",
        id="square-brackets-in-values-are-stable",
    ),
    pytest.param(
        '"password" "correct horse 9"',
        '"password" "[SECRET]"',
        id="keyvalues-pair-is-stable",
    ),
    pytest.param(
        "“password”: hunter2",
        "“password”: [SECRET]",
        id="curly-quoted-keyword-is-stable",
    ),
    pytest.param(
        "Wi-Fi password is: Tr0ub4dor&3 and it is fine",
        "Wi-Fi password is: [SECRET] and it is fine",
        id="connector-colon-redacted-once",
    ),
]


@pytest.mark.parametrize(("text", "expected"), IDEMPOTENCE_CASES)
def test_redaction_is_idempotent(text: str, expected: str) -> None:
    redactor = Redactor(deny_names=["Sarah"], allow_names=["Central Park"])
    once, counts = redactor.redact(text)
    # The first pass must give the known output, and it must count what it changed.
    assert once == expected
    assert counts and all(count > 0 for count in counts.values())
    # A second pass over the output changes nothing.
    assert redactor.redact(once) == (once, {})


def test_long_run_of_card_length_groups_is_redacted_without_recursion():
    redacted, counts = Redactor().redact("4222222222222 " * 994)

    assert redacted == "[CARD] " * 994
    assert counts == {"card": 994}


def test_suffix_check_is_linear_in_the_whitespace_after_a_keyword() -> None:
    started = time.perf_counter()
    assert ends_with_secret_keyword("password" + " " * 100_000 + "x") is False
    assert time.perf_counter() - started < 1.0


def test_a_run_of_keywords_with_no_spaces_is_redacted_in_linear_time() -> None:
    text = "pin:12345678901," * 5000
    started = time.perf_counter()
    redacted, counts = Redactor().redact(text)
    assert time.perf_counter() - started < 1.0
    assert not any(ch.isdigit() for ch in redacted)
    assert counts["secret"] == 1


def test_apostrophes_after_letters_are_scanned_in_linear_time() -> None:
    text = "a'" * 40000
    started = time.perf_counter()
    assert Redactor().redact(text) == (text, {})
    assert time.perf_counter() - started < 1.0


def test_hosts_inside_a_long_query_are_scanned_in_linear_time() -> None:
    text = "x.com?" + ("a.com?" * 13335)[:79993] + "["
    started = time.perf_counter()
    # The query is long, so it is dropped even before the bracket.
    assert Redactor().redact(text) == ("x.com[", {"url": 1})
    assert time.perf_counter() - started < 1.0


def test_local_part_of_64_characters_is_read() -> None:
    assert Redactor().redact("x" * 64 + "@example.com") == ("[EMAIL]", {"email": 1})


def test_long_query_before_a_bracket_is_dropped() -> None:
    assert Redactor().redact(
        "Mail sarah@example.com?token=abcdefghijklmnopqrstuvwxyz0123[NAME] now"
    ) == (
        "Mail [EMAIL][NAME] now",
        {"email": 1},
    )
    assert Redactor().redact(
        "see example.com?token=abcdefghijklmnopqrstuvwxyz0123[NAME] now"
    ) == (
        "see example.com[NAME] now",
        {"url": 1},
    )


def test_short_query_before_a_bracket_is_kept() -> None:
    assert Redactor().redact("Mail sarah@example.com?x=[NAME] now") == (
        "Mail [EMAIL]?x=[NAME] now",
        {"email": 1},
    )


def test_chain_of_placeholders_followed_by_colons_is_redacted_in_few_passes() -> None:
    text = "password: " + "wxyz: " * 300
    started = time.perf_counter()
    redacted, counts = Redactor().redact(text)
    assert time.perf_counter() - started < 1.0
    assert redacted == "password: [SECRET]: " + "wxyz: " * 299
    assert counts == {"secret": 1}


def test_query_key_with_question_marks_is_scanned_in_linear_time() -> None:
    text = "a.bc?9:" * 4000 + "=x"
    started = time.perf_counter()
    redacted, counts = Redactor().redact(text)
    assert counts == {"url": 1}
    assert "?9:" not in redacted
    assert time.perf_counter() - started < 1.0


def test_curly_opening_quotes_without_a_close_are_scanned_in_linear_time() -> None:
    text = "pin:“" * 19999
    started = time.perf_counter()
    redacted, counts = Redactor().redact(text)
    assert time.perf_counter() - started < 1.0
    assert counts == {"secret": 1}
    assert Redactor().redact(redacted) == (redacted, {})


def test_key_less_query_runs_are_redacted_in_linear_time() -> None:
    text = "https://a?b," * 2000 + " 12 34"
    started = time.perf_counter()
    redacted, counts = Redactor().redact(text)
    assert time.perf_counter() - started < 1.0
    assert counts == {"url": 1}
    assert redacted.endswith(" 12 34")
