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
    pytest.param(
        "Connect postgres://app:s3cret@db.example.com:5432/prod now",
        "Connect postgres://db.example.com:5432/prod now",
        {"url": 1},
        id="url-credentials-any-scheme",
    ),
    pytest.param(
        "Use redis://:pw123@cache:6379/0 and ssh://deploy:key@host/x",
        "Use redis://cache:6379/0 and ssh://host/x",
        {"url": 2},
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
        "Open https://example.com/?ref=40K4LpE5h5M9 Thanks",
        "Open https://example.com/ Thanks",
        {"url": 1},
        id="query-mixed-token-with-digit-ending-is-dropped",
    ),
    pytest.param(
        "Open https://example.com/?9Xk2mQ7p now",
        "Open https://example.com/ now",
        {"url": 1},
        id="query-short-mixed-token-starting-with-digit",
    ),
    pytest.param(
        "See https://example.com/item?12345 now",
        "See https://example.com/item?12345 now",
        {},
        id="known-gap-digits-only-short-query-is-kept",
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
        "Pay GB82-WEST-1234-5698-7654-32 today",
        "Pay [IBAN] today",
        {"iban": 1},
        id="iban-with-hyphen-separators",
    ),
    pytest.param(
        "Pay GB82  WEST 1234 5698 7654 32 today",
        "Pay [IBAN] today",
        {"iban": 1},
        id="iban-with-double-spaces",
    ),
    pytest.param(
        "Batch BR51 2074 2761 2833 failed on the third retry.",
        "Batch BR51 2074 2761 2833 failed on the third retry.",
        {},
        id="neg-brazil-run-shorter-than-registered-length",
    ),
    pytest.param(
        "Pay XQ97WEST123456987654 today",
        "Pay XQ97WEST123456987654 today",
        {},
        id="known-gap-iban-of-unlisted-country-is-kept",
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
    pytest.param(
        "Date 01 12 2026 ok",
        "Date 01 12 2026 ok",
        {},
        id="neg-day-month-year-with-spaces",
    ),
    pytest.param(
        "Ref 4000 0000 0002 ok",
        "Ref 4000 0000 0002 ok",
        {},
        id="neg-twelve-digits-in-groups-are-not-a-phone",
    ),
    pytest.param(
        "Call 5551234567 now",
        "Call 5551234567 now",
        {},
        id="known-gap-unseparated-nanp-exchange-starting-one",
    ),
    pytest.param(
        "1999-12-31 23:59:59 1,000,000 3.14159 1 Jan 2025",
        "1999-12-31 23:59:59 1,000,000 3.14159 1 Jan 2025",
        {},
        id="neg-thousands-group-before-decimal-and-date",
    ),
    pytest.param(
        "1,000,000 15.03.2024",
        "1,000,000 15.03.2024",
        {},
        id="neg-thousands-group-before-dotted-date",
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
        "Card [CARD] 123 now",
        {"card": 1},
        id="card-trailing-digits-are-kept",
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
        "Card 4111\u00a01111\u00a01111\u00a01111 now",
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
        "Card [CARD]123 now",
        {"card": 1},
        id="card-glued-to-security-code",
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
        "Card 4000.[PHONE] now",
        {"phone": 1},
        id="known-gap-zero-led-dotted-card-is-read-as-a-phone",
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
        "4111 1111 1111 1111+1 555 123 4567 5555 4028 6726 7201",
        "[CARD]+1 [PHONE] [CARD]",
        {"card": 2, "phone": 1},
        id="card-glued-to-a-plus-phone-keeps-both-cards",
    ),
    pytest.param(
        "Pay 4111 1111 1111 1111,0333-328036-432535 now",
        "Pay [CARD],[CARD] now",
        {"card": 2},
        id="card-before-a-zero-led-grouped-card-keeps-both",
    ),
    pytest.param(
        "005 3976 0420 4819 6-936-918-8994 now",
        "[PHONE] 6-[PHONE] now",
        {"phone": 2},
        id="phone-starting-inside-a-run-is-fully-hidden",
    ),
    pytest.param(
        "2831 0123 7430 0207+0207 946 0958-41 Station Circle0491-6264-7184 6744.Call\t+15/03/2024\t",
        "2831 [PHONE][PHONE] Station Circle[PHONE] 6744.Call\t+15/03/2024\t",
        {"phone": 3},
        id="phone-split-by-a-new-suffix-stays-hidden",
    ),
    pytest.param(
        "0456.0000.7837.0000-2024-01-15986 Oak Str 0333-328036-432535\t",
        "[PHONE].[PHONE] Oak Str [PHONE]-432535\t",
        {"phone": 3},
        id="phone-before-an-address-stays-hidden",
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
        "Card 4111   1111   1111   1111 now",
        "Card [CARD] now",
        {"card": 1},
        id="card-three-space-separators",
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
        "Walk to 10, Downing Street today",
        "Walk to [ADDRESS] today",
        {"address": 1},
        id="address-comma-after-house-number",
    ),
    pytest.param(
        "I live at 42 Wallaby Way, Sydney.",
        "I live at [ADDRESS], Sydney.",
        {"address": 1},
        id="address-way-suffix",
    ),
    pytest.param(
        "I live at 12 Ångström Road.",
        "I live at [ADDRESS].",
        {"address": 1},
        id="address-latin-initial-letter",
    ),
    pytest.param(
        "Post it to 221-B Baker Street.",
        "Post it to [ADDRESS].",
        {"address": 1},
        id="address-hyphenated-house-number",
    ),
    pytest.param(
        "Meet at 12-14 Main Street.",
        "Meet at [ADDRESS].",
        {"address": 1},
        id="address-house-number-range",
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
    pytest.param(
        "Post it to Flat221 Baker Street.",
        "Post it to Flat221 Baker Street.",
        {},
        id="known-gap-house-number-glued-to-word-is-kept",
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
        "Go to example.com?token=abcdefghijklmnopqrs 12 34 next",
        "Go to example.com?token=abcdefghijklmnopqrs 12 34 next",
        {},
        id="short-value-before-two-groups-is-kept",
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
    pytest.param(
        "@Sarah can you check",
        ["Sarah"],
        [],
        "@[NAME] can you check",
        {"name": 1},
        id="name-after-at-sign-at-the-start-is-a-mention",
    ),
    pytest.param(
        "See sarah-co.example.com today",
        ["Sarah"],
        [],
        "See [NAME]-co.example.com today",
        {"name": 1},
        id="name-before-hyphen-in-host-is-redacted",
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
