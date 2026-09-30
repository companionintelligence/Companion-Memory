-- migrate:up
-- Repair: convert the HTML Google Calendar wrote into .ics DESCRIPTIONs to the
-- plain text the parser now produces.
--
-- ## The bug
--
-- RFC 5545 §3.8.1.5 makes DESCRIPTION plain TEXT, but Google Calendar writes an
-- event's rich-text body into it as HTML — `<b>Booked by</b>`, `<br>`,
-- `<a href>`, lists, tables — with real newlines mixed in. calendar.ts stored it
-- as-is, so the markup was displayed in Memory's event details
-- (`<b>Booked by</b> Seda Goff…`), indexed for search and embedded.
--
-- Fixed for future imports in the same commit: `icsDescriptionText` converts a
-- description that carries a real HTML tag with the shared htmlToText
-- (newlines kept, a link's URL kept after its text). A re-import does NOT
-- repair rows already stored, because `INGEST_REFRESH_COLUMNS.event` is `[]`:
-- an idempotent re-push of the same triple refreshes nothing on an event. So
-- the existing rows are converted here.
--
-- ## Measured on the reference corpus
--
-- 1,841 ICS events, 193 whose description carries a tag (the Apple export of a
-- Google calendar, plus Takeout). The 193 hold 877 `<br>`, 228 `<b>`, 137
-- `<a>`, 132 `<li>`, 64 `<td>`; the only entities are `&nbsp;` (293), `&amp;`
-- (100), `&#39;` (4) and `&gt;` (1). 27 links in 17 of them name a
-- destination their text does not show ("here", "this invite link"), and a
-- plain tag-strip would lose it — which is why this keeps it.
--
-- ## Why a SQL twin of htmlToText, and how close it is
--
-- dbmate runs SQL, and the durable rows hold no other copy of the source text
-- to re-parse. `pg_temp.ics_html_to_text` below follows htmlToText's rules
-- (block tags and `<br>` newline additively, capped at one blank line; `</td>`
-- a tab; skip-tags dropped with their content; whitespace collapsed; links as
-- `text (url)` unless the text already shows the address; Google `/url?q=`
-- unwrapped). It is not htmlparser2: it keeps no element stack, so malformed
-- markup (`<li>a<li>b`, a stray `</p>`) can get a line break fewer than a fresh
-- import, and it decodes the entities Google writes plus numeric ones —
-- anything else stays as written. On all 193 reference rows its output is
-- byte-identical to the TypeScript converter's (compared before commit). It
-- lives in pg_temp and is dropped at the end, so nothing outlives this
-- migration.
--
-- ## Scope guards
--
-- Provenance first (`source_system = 'calendar'` AND `metadata->>'Source' =
-- 'ICS'`, the two stamps calendar.ts writes), then the same closed tag list as
-- `ICS_HTML_TAG` in calendar.ts — a plain description that merely holds
-- `Ada <ada@example.com>` or `2 < 3` is not HTML and is left alone.
--
-- The displayed description is replaced only while it is still the importer's
-- own text: a prefix of the metadata value as the push cleaned it (the push
-- caps it at 4,000 characters). All 193 reference rows qualify. A description
-- the user edited in Memory is left as they wrote it; its metadata copy, which
-- is the importer's bag, is still converted.
--
-- Re-running selects nothing: a converted description has no tag left for the
-- guard to match (short of one that spelled `&lt;b&gt;` out as text).
--
-- Dry run on the reference appliance (statements below, in order): 193 rows
-- captured; 193 `ci.entities.description` converted; 193 `ci.events.metadata`
-- converted; 383 search-ledger rows re-armed. Afterwards 0 descriptions carry
-- a tag, and all 1,841 calendar events are still there.

CREATE FUNCTION pg_temp.ics_decode_entities(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  result text := '';
  rest text := t;
  pos int;
  m text[];
  code int;
BEGIN
  LOOP
    pos := strpos(rest, '&');
    EXIT WHEN pos = 0;

    result := result || left(rest, pos - 1);
    rest := substr(rest, pos);
    m := regexp_match(rest, '^&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});');

    IF m IS NULL THEN
      result := result || '&';
      rest := substr(rest, 2);
      CONTINUE;
    END IF;

    IF m[1] ~ '^#[xX]' THEN
      code := ('x' || lpad(substr(m[1], 3), 8, '0'))::bit(32)::int;
    ELSIF m[1] ~ '^#' THEN
      code := substr(m[1], 2)::int;
    ELSE
      code := NULL;
    END IF;

    result := result || CASE
      WHEN m[1] ~ '^#' AND (code = 0 OR code > 1114111 OR code BETWEEN 55296 AND 57343) THEN chr(65533)
      WHEN m[1] ~ '^#' THEN chr(code)
      WHEN m[1] = 'amp' THEN '&'
      WHEN m[1] = 'lt' THEN '<'
      WHEN m[1] = 'gt' THEN '>'
      WHEN m[1] = 'quot' THEN '"'
      WHEN m[1] = 'apos' THEN ''''
      WHEN m[1] = 'nbsp' THEN chr(160)
      WHEN m[1] = 'ndash' THEN chr(8211)
      WHEN m[1] = 'mdash' THEN chr(8212)
      WHEN m[1] = 'lsquo' THEN chr(8216)
      WHEN m[1] = 'rsquo' THEN chr(8217)
      WHEN m[1] = 'ldquo' THEN chr(8220)
      WHEN m[1] = 'rdquo' THEN chr(8221)
      WHEN m[1] = 'bull' THEN chr(8226)
      WHEN m[1] = 'hellip' THEN chr(8230)
      WHEN m[1] = 'middot' THEN chr(183)
      WHEN m[1] = 'copy' THEN chr(169)
      WHEN m[1] = 'reg' THEN chr(174)
      WHEN m[1] = 'trade' THEN chr(8482)
      ELSE '&' || m[1] || ';'
    END;
    rest := substr(rest, length(m[1]) + 3);
  END LOOP;

  RETURN result || rest;
END
$fn$;

-- Percent-decoding for the `q` of a Google `/url?q=` redirect, as
-- URLSearchParams does it (`+` is a space).
CREATE FUNCTION pg_temp.ics_url_decode(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  bytes bytea := '';
  i int := 1;
  c text;
BEGIN
  WHILE i <= length(t) LOOP
    c := substr(t, i, 1);
    IF c = '%' AND substr(t, i + 1, 2) ~ '^[0-9A-Fa-f]{2}$' THEN
      bytes := bytes || decode(substr(t, i + 1, 2), 'hex');
      i := i + 3;
    ELSE
      bytes := bytes || convert_to(CASE WHEN c = '+' THEN ' ' ELSE c END, 'UTF8');
      i := i + 1;
    END IF;
  END LOOP;

  RETURN convert_from(bytes, 'UTF8');
EXCEPTION WHEN others THEN
  RETURN t;
END
$fn$;

-- canonical.ts `str()`: what the push made of the metadata value before it
-- became `ci.entities.description` — control characters and U+FFFC dropped,
-- then trimmed the JS way (btrim alone strips only spaces, and 4 of the 193
-- reference descriptions start with a newline).
CREATE FUNCTION pg_temp.ics_push_str(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(
    regexp_replace(t, '[\x01-\x08\x0b\x0c\x0e-\x1f\ufffc]', '', 'g'),
    '^[\s\u00a0\ufeff\u2028\u2029]+|[\s\u00a0\ufeff\u2028\u2029]+$', '', 'g')
$fn$;

-- htmlToText(html, { preserveNewlines: true, keepLinkUrls: true }).
CREATE FUNCTION pg_temp.ics_html_to_text(html text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  block_tags CONSTANT text[] := ARRAY[
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figure',
    'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
    'ol', 'p', 'pre', 'section', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul'];
  skip_tags CONSTANT text[] := ARRAY['script', 'style', 'head', 'title', 'noscript', 'template'];
  void_tags CONSTANT text[] := ARRAY[
    'area', 'base', 'basefont', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr'];
  -- JS `\s` beyond ASCII, which Postgres' locale-dependent class may not cover.
  ws CONSTANT text := '[\s   -     　]+';
  address_like CONSTANT text :=
    '^((https?://|www\.)[^\s]+|[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+|[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.[A-Za-z]{2,}(/[^\s]*)?)$';
  out text := '';
  pending_newlines int := 0;
  pending_tab boolean := false;
  pending_space boolean := false;
  skip_depth int := 0;
  link_target text;
  link_start int;
  tok text[];
  tag_name text;
  closing boolean;
  events text[];
  ev text;
  runs text[];
  run text;
  collapsed text;
  trimmed text;
  href text;
  host text;
  q text;
  link_text text;
  first_run boolean;
BEGIN
  -- Comments are not text.
  html := regexp_replace(html, '<!--.*?-->', '', 'g');

  FOR tok IN
    SELECT regexp_matches(
      html,
      '(<(/?)([A-Za-z][^\s/>]*)((?:[^>"'']|"[^"]*"|''[^'']*'')*)>)|([^<]+)|(<)',
      'g')
  LOOP
    runs := NULL;

    IF tok[1] IS NOT NULL THEN
      tag_name := lower(tok[3]);
      closing := tok[2] = '/';
      -- htmlparser2 closes a void element the moment it opens, and reads
      -- `</br>` as `<br>`.
      IF closing AND tag_name = 'br' THEN
        events := ARRAY['open'];
      ELSIF closing THEN
        events := ARRAY['close'];
      ELSIF tag_name = ANY (void_tags) THEN
        events := ARRAY['open', 'close'];
      ELSE
        events := ARRAY['open'];
      END IF;

      FOREACH ev IN ARRAY events LOOP
        IF tag_name = ANY (skip_tags) THEN
          IF ev = 'open' THEN
            skip_depth := skip_depth + 1;
          ELSIF skip_depth > 0 THEN
            skip_depth := skip_depth - 1;
          END IF;
          CONTINUE;
        END IF;

        CONTINUE WHEN skip_depth > 0;

        IF ev = 'open' THEN
          IF tag_name = 'a' THEN
            href := coalesce(
              substring(tok[4] from '(?i)\mhref\s*=\s*"([^"]*)"'),
              substring(tok[4] from '(?i)\mhref\s*=\s*''([^'']*)'''),
              substring(tok[4] from '(?i)\mhref\s*=\s*([^\s"''>]+)'));
            href := btrim(pg_temp.ics_decode_entities(coalesce(href, '')), E' \t\n\r\f');
            link_target := NULL;

            IF href ~* '^mailto:' THEN
              link_target := nullif(split_part(substr(href, 8), '?', 1), '');
            ELSIF href ~* '^https?://' THEN
              link_target := href;
              host := substring(href from '(?i)^https?://([^/?#:]+)');
              IF host ~* '^(www\.)?google\.[a-z.]+$'
                 AND substring(href from '(?i)^https?://[^/?#]+(/[^?#]*)') = '/url' THEN
                q := pg_temp.ics_url_decode(substring(href from '[?&]q=([^&#]*)'));
                IF q ~* '^https?://' THEN
                  link_target := q;
                END IF;
              END IF;
            END IF;

            link_start := length(out);
          ELSIF tag_name = 'br' OR tag_name = ANY (block_tags) THEN
            pending_newlines := least(pending_newlines + 1, 2);
          END IF;
        ELSE
          IF tag_name = 'a' AND link_target IS NOT NULL THEN
            link_text := btrim(substr(out, link_start + 1), E' \t\n');
            IF link_text = '' THEN
              runs := ARRAY[' ' || link_target || ' '];
            ELSIF NOT (link_text ~* address_like
                       OR strpos(link_text, link_target) > 0
                       OR strpos(link_text, regexp_replace(regexp_replace(link_target, '^https?://', '', 'i'), '/$', '')) > 0)
            THEN
              out := out || ' (' || link_target || ')';
            END IF;
            link_target := NULL;
          ELSIF tag_name = 'td' OR tag_name = 'th' THEN
            pending_tab := true;
          ELSIF tag_name = ANY (block_tags) THEN
            pending_newlines := least(pending_newlines + 1, 2);
          END IF;
        END IF;
      END LOOP;

      CONTINUE WHEN runs IS NULL;
    ELSE
      CONTINUE WHEN skip_depth > 0;
      -- preserveNewlines: every newline in a text run is a line break.
      runs := regexp_split_to_array(pg_temp.ics_decode_entities(coalesce(tok[5], tok[6])), E'\r\n|\r|\n');
    END IF;

    first_run := true;
    FOREACH run IN ARRAY runs LOOP
      IF NOT first_run THEN
        pending_newlines := least(pending_newlines + 1, 2);
      END IF;
      first_run := false;

      collapsed := regexp_replace(
        regexp_replace(run, '[­​-‍⁠﻿]', '', 'g'), ws, ' ', 'g');
      trimmed := btrim(collapsed, ' ');

      IF trimmed = '' THEN
        IF collapsed <> '' THEN
          pending_space := true;
        END IF;
        CONTINUE;
      END IF;

      IF left(collapsed, 1) = ' ' THEN
        pending_space := true;
      END IF;

      IF pending_newlines > 0 THEN
        IF out <> '' THEN
          out := out || repeat(E'\n', least(pending_newlines, 2));
        END IF;
      ELSIF pending_tab THEN
        IF out <> '' AND right(out, 1) <> E'\n' THEN
          out := out || E'\t';
        END IF;
      ELSIF pending_space THEN
        IF out <> '' AND right(out, 1) <> E'\n' THEN
          out := out || ' ';
        END IF;
      END IF;
      pending_newlines := 0;
      pending_tab := false;
      pending_space := false;

      out := out || trimmed;
      IF right(collapsed, 1) = ' ' THEN
        pending_space := true;
      END IF;
    END LOOP;
  END LOOP;

  out := regexp_replace(out, '[ \t]+\n', E'\n', 'g');
  out := regexp_replace(out, '\n{3,}', E'\n\n', 'g');
  out := regexp_replace(out, '^[ \t]+|[ \t]+$', '', 'gn');

  RETURN btrim(out, E' \t\n\r\f\v');
END
$fn$;

-- The rows to repair, with their converted values, captured ONCE: the statements
-- below change exactly what this selects on.
CREATE TEMP TABLE ics_html_repair ON COMMIT DROP AS
SELECT ev.event_id,
       nullif(pg_temp.ics_html_to_text(ev.metadata->>'Description'), '') AS text,
       e.description IS NOT NULL
         AND e.description <> ''
         AND strpos(pg_temp.ics_push_str(ev.metadata->>'Description'), e.description) = 1 AS importer_owned
  FROM ci.events ev
  JOIN ci.entities e ON e.entity_id = ev.event_id
 WHERE ev.source_system = 'calendar'
   AND ev.metadata->>'Source' = 'ICS'
   AND ev.metadata->>'Description' ~* '<\/?(a|b|body|br|div|em|font|h[1-6]|hr|html|i|img|li|ol|p|span|strong|table|tbody|td|th|thead|tr|u|ul)\M[^>]*>';

-- 1. The description Memory displays, searches and embeds. `left(…, 4000)` is
--    the push's DESCRIPTION_MAX (canonical.ts); no converted reference row
--    comes near it. NULL when nothing is left, like every description-less event.
UPDATE ci.entities e
   SET description = left(r.text, 4000),
       updated_at = now()
  FROM ics_html_repair r
 WHERE e.entity_id = r.event_id
   AND r.importer_owned;

-- 2. The importer's metadata copy. Dropped rather than nulled when empty, the
--    shape calendar.ts gives a description-less event (`|| undefined`).
UPDATE ci.events ev
   SET metadata = CASE
         WHEN r.text IS NULL THEN ev.metadata - 'Description'
         ELSE jsonb_set(ev.metadata, '{Description}', to_jsonb(r.text))
       END,
       updated_at = now()
  FROM ics_html_repair r
 WHERE ev.event_id = r.event_id;

-- 3. The ledger rows for the two search stages, so the sweep rebuilds the
--    tsvector and the embedding from the converted text. Ledger rows, not
--    ci_search rows: `ci_search.vectors` is the search CANDIDATE source, so a
--    deleted vector is an event that answers nothing until the sweep comes
--    back, while a deleted ledger row keeps the old vector searchable in the
--    meantime (see 20260821024635_clear_ics_valarm_boilerplate_descriptions).
DELETE FROM ci.pipeline_state ps
 USING ics_html_repair r
 WHERE ps.entity_id = r.event_id
   AND ps.entity_type = 'event'
   AND ps.stage IN ('index.vector_event', 'index.embed_event');

DROP FUNCTION pg_temp.ics_html_to_text(text);
DROP FUNCTION pg_temp.ics_push_str(text);
DROP FUNCTION pg_temp.ics_url_decode(text);
DROP FUNCTION pg_temp.ics_decode_entities(text);

-- ## Post-migration verification
--
-- Should be 0:
--   SELECT count(*) FROM ci.events ev
--    WHERE ev.source_system = 'calendar' AND ev.metadata->>'Source' = 'ICS'
--      AND ev.metadata->>'Description' ~* '<\/?(a|b|br|p|li|td)\M[^>]*>';

-- migrate:down
-- No-op: irreversible data repair. The markup is not worth restoring — nothing
-- renders it — and the original is still in the user's .ics export.
