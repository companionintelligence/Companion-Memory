-- migrate:up

-- Index every email and phone a contact card states — not only the one
-- handle its natural key was built from — and drop the fake numbers that
-- extensions left behind.
--
-- ## The bug this cleans up after
--
-- Staging kept exactly ONE handle per contact: the lexicographically smallest
-- (`import/staging/identity.ts` `entityIdentityKey`), and `push/entities.ts`
-- wrote only that one into `properties.email(s)` / `properties.phone(s)` — the
-- keys `GraphIngestService` indexes into `ci.entity_identifiers` and
-- `enrich.person_self_claim` turns into claims. Digits sort before letters, so
-- a card with ANY phone never had its email indexed: 600 of the 1,018 cards
-- with an email in one real 4,927-card export. Mail from those addresses could
-- not resolve to the contact and minted a stub Person instead, and the
-- duplicate detector's email tier never saw the card at all — 63 addresses in
-- that export are shared by cards that stayed separate people.
--
-- And the one handle could be a fake. A number with an extension keys on the
-- last ten digits of ALL its digits: "(310) 447-8675;229" became 4478675229, a
-- plausible number in a real area code, indexed as the contact's phone.
--
-- The forward fix records every contact method at staging (`contactIdentifiers`)
-- and indexes it at push, extensions excluded. It repairs nothing that already
-- landed. The vCard parser, though, always kept the card's full lists as typed,
-- under the capitalised `Emails` / `Phones` — so those rows CAN be repaired
-- here, from their own properties. (Apple Contacts databases and contact-list
-- CSVs kept no such lists; their other handles come back on the next import.)
--
-- ## What counts as a contact method — the same rule as the TypeScript
--
--  - an email: the address inside `<…>` when there is one, `mailto:` dropped,
--    lower-cased and trimmed (`normalizeEmail`), shaped like a mailbox, and
--    NOT an organizational one (`isOrganizationalAddress`: a role local part
--    before any `+`, or a non-routable TLD). `info@` on a colleague's card is
--    the office's; indexed under the first colleague, it would claim every
--    message the office sends.
--  - a phone: `tel:` dropped, written like a number (`^\+?[0-9 ().\-/]+$`),
--    at least seven digits, keyed on its last ten — and NOT a number with an
--    extension: `PHONE_EXTENSION_PATTERN` (`graph/utils/normalizeIdentifier.ts`,
--    embedded below verbatim and pinned by its spec — `x229`, `ext: 229`,
--    `extn`, a `;` `,` `#` dial suffix, Android `p`/`w` between digits).
--  - never a number the card files under `Faxes`. Rows imported before faxes
--    were filed apart have none, and keep their fax among `Phones`; the next
--    import of the card files it apart, and the phone adjudicator refuses it.
--  - nothing at all from a row that is SEVERAL people. Staging collapsed
--    sightings on their identity key, so a household on one home line, or an
--    office on its switchboard before #2795, is one row whose `Emails` /
--    `Phones` hold every member's. Its `Names` say so: more than one distinct
--    first name, or a name that is no name (a number, an address) among
--    several. Stricter than the push's `describesSeveralPeople` (it cannot
--    tell a nickname from a sibling), which only costs such a row its repair.
--
-- Postgres regex word boundaries are `\y` (`\b` is a BACKSPACE here — see
-- 20260818220833, which learned it the hard way).
--
-- ## What is written
--
-- 1. `properties.emails` / `properties.phones` gain the card's methods after
--    the ones already there (merges and other sources keep theirs, in order),
--    and `phones` loses every key that only an extension number produced;
--    `email` / `phone` are set where missing, and `phone` is replaced where it
--    was such a fake. Only live, unmerged Persons whose lists change are
--    touched — and a merge SURVIVOR (a row another row is merged into) keeps
--    its fakes: `PersonMergeService` unions `phones` / `Phones`, so on a
--    survivor the same ten digits can be a merged-in record's real number.
-- 2. `ci.entity_identifiers` loses the phone rows those fakes put under the
--    same Person, whatever their `source` / `verified_at`: saving the person
--    form round-trips every identifier row it shows, and `replaceForEntity`
--    promotes each one to `source = 'user'`, `verified_at = now()` — the fake
--    included — so "verified" says nothing about who typed it. What does is
--    `raw_value`: an import's fake has none, and a round-trip never writes one,
--    while a row a user typed keeps the typed form. Only `raw_value IS NULL`
--    rows go; a typed one is the user's, and a typed extension is left for
--    the repair that can copy it onto the card before removing it. It gains a row
--    per new method, `ON CONFLICT DO NOTHING`: first writer wins, exactly as at
--    import, and the earliest of two same-named Persons claims a value both
--    state (the losing pair is what the duplicate detector exists to find).
--    NOT a value another card here lists under a different name: an office
--    line on colleagues' cards, or the owner's work address on a friend's
--    card, indexed under whichever card is older, would resolve every call or
--    message from it to that card. The import leaves those out the same way
--    (`markSharedContactHandles`, from the whole export; only the names
--    survive here, so this reads them strictly). They stay in `properties`,
--    where the merge queue can see them. `source` NULL and `raw_value` the
--    card's typed form, as `EntityIdentifierService` writes them.
--
-- Claims follow from the code, not from here: `enrich.person_self_claim`
-- (PERSON_SELF_CLAIM_GENERATION 2) re-reads every Person's `emails` / `phones`
-- and retracts what they no longer state, and `clean.duplicate_detect`
-- (DUPLICATE_CANDIDATE_GENERATION 3) re-sweeps behind it.
--
-- Idempotent: a second run finds nothing to change.

-- Scratch tables, dropped at the end; a failed run rolls them back with its
-- transaction.
--
-- The rows a card repair can reach, with every list read as an array.
CREATE TEMP TABLE contact_card AS
SELECT e.entity_id,
       e.owner_user_id,
       e.created_at,
       lower(btrim(COALESCE(e.name, ''))) AS name_key,
       COALESCE((
         SELECT count(DISTINCT lower(btrim(n.value))) > 1
                AND (count(DISTINCT lower(regexp_replace(split_part(btrim(n.value), ' ', 1), '[^[:alpha:]]', '', 'g'))) > 1
                     OR bool_or(regexp_replace(split_part(btrim(n.value), ' ', 1), '[^[:alpha:]]', '', 'g') = ''))
           FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.properties -> 'Names') = 'array'
                                               THEN e.properties -> 'Names' ELSE '[]'::jsonb END) AS n(value)
          WHERE btrim(n.value) <> ''), false) AS several_people,
       CASE WHEN jsonb_typeof(e.properties -> 'Emails') = 'array'
            THEN e.properties -> 'Emails' ELSE '[]'::jsonb END AS card_emails,
       CASE WHEN jsonb_typeof(e.properties -> 'Phones') = 'array'
            THEN e.properties -> 'Phones' ELSE '[]'::jsonb END AS card_phones,
       CASE WHEN jsonb_typeof(e.properties -> 'Faxes') = 'array'
            THEN e.properties -> 'Faxes' ELSE '[]'::jsonb END AS card_faxes,
       CASE jsonb_typeof(e.properties -> 'emails')
            WHEN 'array' THEN e.properties -> 'emails'
            WHEN 'string' THEN jsonb_build_array(e.properties -> 'emails')
            ELSE '[]'::jsonb END AS known_emails,
       CASE jsonb_typeof(e.properties -> 'phones')
            WHEN 'array' THEN e.properties -> 'phones'
            WHEN 'string' THEN jsonb_build_array(e.properties -> 'phones')
            ELSE '[]'::jsonb END AS known_phones
  FROM ci.entities e
 WHERE e.entity_type = 'Person'
   AND COALESCE(e.is_active, true) = true
   AND e.merged_into_entity_id IS NULL
   AND (e.properties ? 'Emails' OR e.properties ? 'Phones');

-- Every contact method a card states, normalized; `ord` keeps card order.
CREATE TEMP TABLE contact_card_method AS
WITH email_value AS (
  SELECT c.entity_id,
         raw.ord,
         raw.value AS raw_value,
         lower(btrim(COALESCE(
           substring(regexp_replace(btrim(raw.value), '^mailto:', '', 'i') FROM '<([^>]+)>'),
           regexp_replace(btrim(raw.value), '^mailto:', '', 'i')
         ))) AS value
    FROM contact_card c
    CROSS JOIN LATERAL jsonb_array_elements_text(c.card_emails) WITH ORDINALITY AS raw(value, ord)
),
phone_value AS (
  SELECT c.entity_id,
         raw.ord,
         raw.value AS raw_value,
         btrim(regexp_replace(btrim(raw.value), '^tel:', '', 'i')) AS written
    FROM contact_card c
    CROSS JOIN LATERAL jsonb_array_elements_text(c.card_phones) WITH ORDINALITY AS raw(value, ord)
)
SELECT v.entity_id, 'email'::text AS kind, v.value, v.raw_value, v.ord
  FROM email_value v
 WHERE v.value ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   AND split_part(split_part(v.value, '@', 1), '+', 1) NOT IN (
         'info', 'support', 'service', 'shop', 'sales', 'contact', 'hello', 'office',
         'admin', 'billing', 'help', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
         'notification', 'notifications', 'newsletter', 'news', 'press', 'jobs',
         'privacy', 'security', 'marketing', 'mailer-daemon', 'postmaster', 'bounce',
         'bounces')
   AND regexp_replace(v.value, '^.*\.', '') NOT IN (
         'intern', 'internal', 'local', 'lan', 'test', 'invalid', 'localhost')
UNION ALL
SELECT p.entity_id, 'phone', right(regexp_replace(p.written, '\D', '', 'g'), 10), p.raw_value, p.ord
  FROM phone_value p
  JOIN contact_card c ON c.entity_id = p.entity_id
 WHERE p.written ~ '^\+?[0-9[:space:]().\-/]+$'
   AND p.written !~* '[;,#]|(?:^|[^a-z])(?:ext(?:ension|n)?|x)\.?\s*:?\s*\d|\d\s*[pw]\s*\d'
   AND length(regexp_replace(p.written, '\D', '', 'g')) >= 7
   AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(c.card_faxes) fax(value)
          WHERE right(regexp_replace(fax.value, '\D', '', 'g'), 10)
                = right(regexp_replace(p.written, '\D', '', 'g'), 10));

-- The keys only an extension number produced: its last ten digits are no
-- number. A key a real line of the same card also produces is not a fake, and
-- a merge survivor's keys are not judged at all (see 1. above).
CREATE TEMP TABLE contact_card_fake_phone AS
SELECT DISTINCT c.entity_id,
       right(regexp_replace(btrim(regexp_replace(btrim(raw.value), '^tel:', '', 'i')), '\D', '', 'g'), 10) AS value
  FROM contact_card c
  CROSS JOIN LATERAL jsonb_array_elements_text(c.card_phones) AS raw(value)
 WHERE btrim(regexp_replace(btrim(raw.value), '^tel:', '', 'i')) ~* '[;,#]|(?:^|[^a-z])(?:ext(?:ension|n)?|x)\.?\s*:?\s*\d|\d\s*[pw]\s*\d'
   AND length(regexp_replace(raw.value, '\D', '', 'g')) >= 7
   AND NOT EXISTS (SELECT 1 FROM ci.entities s WHERE s.merged_into_entity_id = c.entity_id);

DELETE FROM contact_card_fake_phone f
 USING contact_card_method m
 WHERE m.entity_id = f.entity_id
   AND m.kind = 'phone'
   AND m.value = f.value;

-- 1. The record: known values first, minus fakes, then what the card adds.
WITH listed AS (
  SELECT c.entity_id,
         (SELECT COALESCE(jsonb_agg(x.value ORDER BY x.pos), '[]'::jsonb)
            FROM (SELECT DISTINCT ON (u.value) u.value, u.pos
                    FROM (SELECT k.value, k.ord AS pos
                            FROM jsonb_array_elements_text(c.known_emails) WITH ORDINALITY AS k(value, ord)
                          UNION ALL
                          SELECT m.value, 1000000 + m.ord
                            FROM contact_card_method m
                           WHERE m.entity_id = c.entity_id AND m.kind = 'email' AND NOT c.several_people) u
                   ORDER BY u.value, u.pos) x) AS emails,
         (SELECT COALESCE(jsonb_agg(x.value ORDER BY x.pos), '[]'::jsonb)
            FROM (SELECT DISTINCT ON (u.value) u.value, u.pos
                    FROM (SELECT k.value, k.ord AS pos
                            FROM jsonb_array_elements_text(c.known_phones) WITH ORDINALITY AS k(value, ord)
                           WHERE NOT EXISTS (
                                   SELECT 1 FROM contact_card_fake_phone f
                                    WHERE f.entity_id = c.entity_id AND f.value = k.value)
                          UNION ALL
                          SELECT m.value, 1000000 + m.ord
                            FROM contact_card_method m
                           WHERE m.entity_id = c.entity_id AND m.kind = 'phone' AND NOT c.several_people) u
                   ORDER BY u.value, u.pos) x) AS phones
    FROM contact_card c
)
UPDATE ci.entities e
   SET properties = (e.properties - 'emails' - 'phones' - 'email' - 'phone')
                    || CASE WHEN jsonb_array_length(l.emails) > 0
                            THEN jsonb_build_object('emails', l.emails) ELSE '{}'::jsonb END
                    || CASE WHEN jsonb_array_length(l.phones) > 0
                            THEN jsonb_build_object('phones', l.phones) ELSE '{}'::jsonb END
                    || CASE WHEN COALESCE(e.properties ->> 'email', '') <> ''
                            THEN jsonb_build_object('email', e.properties -> 'email')
                            WHEN jsonb_array_length(l.emails) > 0
                            THEN jsonb_build_object('email', l.emails -> 0)
                            ELSE '{}'::jsonb END
                    || CASE WHEN COALESCE(e.properties ->> 'phone', '') <> ''
                             AND NOT EXISTS (SELECT 1 FROM contact_card_fake_phone f
                                              WHERE f.entity_id = e.entity_id
                                                AND f.value = e.properties ->> 'phone')
                            THEN jsonb_build_object('phone', e.properties -> 'phone')
                            WHEN jsonb_array_length(l.phones) > 0
                            THEN jsonb_build_object('phone', l.phones -> 0)
                            ELSE '{}'::jsonb END,
       updated_at = now()
  FROM listed l
 WHERE e.entity_id = l.entity_id
   AND (l.emails IS DISTINCT FROM COALESCE(e.properties -> 'emails', '[]'::jsonb)
        OR l.phones IS DISTINCT FROM COALESCE(e.properties -> 'phones', '[]'::jsonb)
        OR (COALESCE(e.properties ->> 'email', '') = '' AND jsonb_array_length(l.emails) > 0)
        OR (COALESCE(e.properties ->> 'phone', '') = '' AND jsonb_array_length(l.phones) > 0)
        OR EXISTS (SELECT 1 FROM contact_card_fake_phone f
                    WHERE f.entity_id = e.entity_id AND f.value = e.properties ->> 'phone'));

-- 2a. The index: a fake is no one's number — verified or not, since a form
--     save verifies what it round-trips. Never a row a user typed (see 2.).
DELETE FROM ci.entity_identifiers ei
 USING contact_card_fake_phone f
 WHERE ei.entity_id = f.entity_id
   AND ei.kind = 'phone'
   AND ei.value_normalized = f.value
   AND ei.raw_value IS NULL;

-- 2b. Every method the card states, first writer wins — unless the row is
--     several people, or another card lists it under a different name.
INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, raw_value)
SELECT m.entity_id, c.owner_user_id, m.kind, m.value, NULLIF(btrim(m.raw_value), m.value)
  FROM contact_card_method m
  JOIN contact_card c ON c.entity_id = m.entity_id
 WHERE NOT c.several_people
   AND NOT EXISTS (
         SELECT 1
           FROM contact_card_method o
           JOIN contact_card oc ON oc.entity_id = o.entity_id
          WHERE oc.owner_user_id = c.owner_user_id
            AND o.kind = m.kind
            AND o.value = m.value
            AND oc.name_key <> c.name_key)
 ORDER BY c.created_at, m.entity_id, m.kind, m.ord
ON CONFLICT (owner_user_id, kind, value_normalized) DO NOTHING;

DROP TABLE contact_card_fake_phone;
DROP TABLE contact_card_method;
DROP TABLE contact_card;

-- migrate:down

-- Irreversible by design, as 20260821024913 is: afterwards every row this
-- touched is what the fixed import writes for the same card, and a down
-- migration keyed on that shape would strip the contact methods of every card
-- imported since, and put the extension fakes back. The identifier rows are a
-- derived index and are left alone.
SELECT 1;
