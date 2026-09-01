/* Google Voice datasource (simplified TypeScript port) */
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { stripCallLogHeading } from '@ci/domains/graph';

import { isShortCode } from '../staging/identity';

import { attachmentMediaKind } from './attachment_extract';
import { matchingDivCloseIndex } from './htmlBlocks';
import { htmlToText } from './htmlToText';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { AttachmentDescriptor, ImportParams, EntityAttribute, Relationship } from './timeline';

type GoogleVoiceOptions = Record<string, never>;

interface GVEntity {
  name?: string;
  phone?: string;
}

/**
 * The staged `type` for one end of a Google Voice conversation.
 *
 * Declared here rather than left to `resolveEntityType`, whose
 * `hasContactIdentity` fallback infers 'contact' only from an attribute long
 * enough to be a HANDLE. Every participant this file stages carries at most a
 * phone, so the ones whose number is too short resolved to a null type and
 * `push/entities.ts entityTypeFor` filed them under `DEFAULT_ENTITY_TYPE` —
 * `Concept` — by accident. On the QA corpus that was 142 rows.
 *
 * The accident landed on the right answer, and that is the point of saying it
 * out loud: those 142 rows are SMS SHORT CODES ("411", "99217", "227898"), the
 * numbers services text from. Google Voice's other end is not a person by
 * construction the way a vCard's is — this is a message log, not an address
 * book — so the type cannot simply be 'contact' the way `vcard.ts`,
 * `contactlist.ts` and `applecontacts.ts` may declare it. A row named "411" in
 * somebody's list of people is wrong, it would enter duplicate detection and
 * the person search index, and nothing downstream would catch it:
 * `isNonNameParticipant` deliberately lets a bare number through ("a short
 * handle, a bare phone number, a single token — all still pass").
 *
 * So: a real handle, or a name with no number at all, is a `contact` and
 * becomes a `Person`; a short code is a `short_code` and keeps falling to
 * `Concept`, which is exactly what that default is documented to mean — "a
 * thing worth having a node for that is neither a person nor a place". The
 * difference from today is that it is now a decision the parser records, not a
 * side effect of a digit threshold in another module.
 *
 * Short codes are staged rather than dropped because they are real
 * correspondents: 5,307 communications on the QA corpus have one as their
 * `from_entity_id`.
 */
function participantType(participant: GVEntity): 'contact' | 'short_code' {
  // The NAME is checked as well as the phone, because a Google Voice export
  // frequently carries the short code ONLY as the counterpart name: the
  // filename prefix ("262966 - Text - 2019-...html") is what becomes the
  // contact name, and such a file has no phone to test. Reading the phone alone
  // typed those as `contact`, and a contact becomes a Person — a fake human
  // named with a marketing short code.
  //
  // Measured on a fresh full-corpus import: 141 short-code participants were
  // typed correctly and 4 leaked through as `contact` (1311, 14242, ...) —
  // small per import, but they accumulate and each one is a person who does not
  // exist.
  //
  // Safe to pass a name to: `isShortCode` requires PHONE_SHAPED, so a value
  // carrying no digits is a name and returns false. 'Adrian Kelly' cannot match;
  // '1311' can.
  return isShortCode(participant.phone) || isShortCode(participant.name) ? 'short_code' : 'contact';
}

/**
 * Is this `<cite class="sender vcard">` the account owner rather than a
 * correspondent?
 *
 * Google Voice writes the owner's own side of every conversation as the literal
 * token `Me` — `<cite class="sender vcard"><a class="tel" href="tel:+1…">
 * <abbr class="fn" title="">Me</abbr></a></cite>`. It is a ROLE MARKER in a
 * fixed markup slot, the export's spelling of "is_from_me", not something the
 * owner is called. `processConversation` already reads it that way to set
 * `Direction`; this predicate is that same reading, applied to the four places
 * that were still treating it as a name — the `participants` loop, the
 * message's `Sender`, an image-only MMS's `Sender`, and a call log's `Contact`.
 *
 * ## What it cost to treat it as a name
 *
 * The owner was staged as an ordinary participant and stamped as
 * `metadata.Sender`, so both minting paths produced the same node: the
 * `participants` loop wrote a `contact` (→ `Person`) named "Me" keyed on the
 * owner's own Google Voice number, and `push/inputs.ts` copied `Sender` into
 * `participants_metadata.from`, from which `PersonLinkStage` indexed a
 * `name`-kind `ci.entity_identifiers` row for "me" and linked it as the sender.
 * On the live appliance that is ONE `Person` row holding 133,859
 * `ci.communications.from_entity_id` — 43% of the Google Voice corpus and 41%
 * of every communication on the box — plus 132,238 `SENT`/`RECEIVED`
 * relationships. The owner is not their own correspondent, and a `name`
 * identifier of "me" is an identity ATTRACTOR: it is UNIQUE on
 * `(owner_user_id, kind, value_normalized)`, so it belongs to exactly one node
 * and every later participant called "Me", from any source, resolves to it.
 *
 * ## Why here and not in `placeholderPersonName.ts`
 *
 * That module's `GENERIC_PLACEHOLDERS` list deliberately EXCLUDES `me` — and
 * says so — because in an ADDRESS BOOK "Me" is a label a human really does file
 * a contact under, and refusing it there would delete a name a `.vcf` honestly
 * contained. The evidence is different here: this is not a name field a person
 * typed, it is a protocol token in a machine-generated markup slot whose
 * meaning the format fixes. A source-specific rule is the only place that
 * distinction can be made, so the shared predicate stays as narrow as it is.
 *
 * Anchored on the name alone. The owner's number is available from `Phones.vcf`
 * (`this.owner.phones`), but a sender block carrying that number under a real
 * display name is not something this corpus contains — every one of the 133,859
 * rows above came through the `Me` token — and widening the rule to "any block
 * whose phone is the owner's" would silently suppress a correspondent on any
 * export where that assumption does not hold. Suppressing too little leaves a
 * countable row; suppressing too much deletes a real person from the graph.
 */
function isOwnerToken(sender: GVEntity): boolean {
  return (sender.name || '').trim().toLowerCase() === 'me';
}

/** Prefix marking a Google Voice thread id that names a FILE, not a contact. */
export const GV_FILE_THREAD_PREFIX = 'googlevoice:file:';

/**
 * Drop the copy index a file manager appends when the SAME export file lands
 * twice — "… (2).html", "…(1).html" — so both replicas describe one record.
 *
 * A Google Voice call/voicemail item carries no `item.id`, so `hashItem` keys
 * it on `sha1(dataSource, classification, content.filename, isoTimestamp)`.
 * The filename is therefore part of its identity, and a Drive/Takeout copy
 * suffix makes one call hash three different ways: on the QA appliance
 * "Chris Spagnuolo - 2013-06-14T15_07_34Z.html", "… (2).html" and "… (3).html"
 * all describe the one 15:07:34 call and reached ci.communications as three
 * rows the provenance arbiter could never collapse. That contradicts what
 * `hashItem` is FOR — it already excludes `intermediateLocation` so the same
 * record replicated into two folders collapses, and a copy index is that same
 * replication wearing a different name.
 *
 * ## Why the timestamp anchor, and not a bare `\s*\(\d+\)$`
 *
 * Google Voice ALSO uses "(n)" to disambiguate its OWN filename collisions,
 * and it truncates a long name before doing so. 419 staged files on the QA
 * appliance have that shape — "Elisabeth (Lisa) Turner - Missed -
 * 2016-01-08T17_3(1).html" beside "…T17_3(2).html" — and those are two
 * DIFFERENT calls whose names were cut mid-timestamp and then made unique.
 * Stripping the index there would merge two real records and delete one of
 * them at staging.
 *
 * So the index comes off only when what remains still ends in a COMPLETE
 * `T##_##_##Z` export timestamp: the shape a whole Google Voice filename has
 * and a truncated one never does. A copy of an already-truncated name keeps
 * its index — a missed collapse costs a duplicate, a wrong collapse costs the
 * record.
 *
 * The rest of the hash input is the second guard: two items only merge when
 * their classification and their millisecond-precision timestamp match as
 * well, so replicas of one export merge and two genuinely different records
 * with similar names do not.
 *
 * Deliberately NOT applied to MMS attachment filenames. Those name real bytes
 * on disk that are read back and uploaded, and Google Voice's own per-message
 * index ("… -1-1.jpg") is already load-bearing there.
 */
export function stripCopyIndex(basename: string): string {
  return basename.replace(/(T\d{2}_\d{2}_\d{2}Z)\s*\(\d+\)(\.[A-Za-z0-9]+)$/, '$1$2');
}

/**
 * The per-conversation grouping key for one exported HTML file.
 *
 * Google Voice exports one file per conversation, and names most of them
 * "<contact> - <Type> - <timestamp>.html", so the contact prefix IS the thread
 * — that is `conversation`, and it is used as the contact NAME elsewhere in
 * this file, which is why it must stay undefined when the filename names
 * nobody ("Group Conversation - 2019-11-11T23_27_25Z.html", "Missed -
 * 2025-01-15T09_30_00Z.html"). See the comment at the `conversation` site.
 *
 * A thread id has no such constraint: it only has to group the right messages
 * and be reproducible. So when the name carries no contact, fall back to the
 * FILE's own identity. On the live corpus that is 12,962 items across 1,655
 * "Group Conversation" files — up to 265 messages each — which otherwise land
 * with ci.communications.thread_id NULL and no grouping at all.
 *
 * Deliberately NOT derived from the participant set. Google Voice records only
 * the owner's own number in a group file's per-message recipients (verified on
 * the live data: every "to" in a group file is the owner), so the only
 * participant set available is "senders who happened to speak in this file" —
 * i.e. exactly this file, but computed in a way that changes whenever a member
 * stays quiet. The file id is the same grouping, stable across re-imports, and
 * can never merge two different group chats.
 *
 * The extension is stripped so the value does not read as a filename, and the
 * `googlevoice:file:` prefix marks it as synthetic rather than a contact.
 *
 * The copy index goes too (see {@link stripCopyIndex}): a file the exporter
 * replicated is not a second conversation, and without this the two copies of
 * one "Group Conversation" file become two threads holding the same messages.
 */
export function threadKeyFor(fpath: string, conversation: string | undefined): string {
  if (conversation) {
    return conversation;
  }

  const base = stripCopyIndex(path.basename(fpath));

  return `${GV_FILE_THREAD_PREFIX}${base.replace(/\.[^.]+$/, '')}`;
}

/**
 * The spoken text of a voicemail.
 *
 * Google Voice stores it as `<span class="full-text">` nested inside the
 * `<span class="description">` of the hAudio block:
 *
 *   <span class="description"><span class="full-text">the transcript</span>
 *     <span class="word high">the<span class="start-time">…</span>
 *       <span class="end-time">…</span><span class="confidence">0.94</span></span>
 *     …one such span per word…
 *   </span>
 *
 * This used to read `<span class="note">`, which is what an older export shape
 * used and what the comment above still described. That class does not occur
 * ONCE in a current export — 0 of 71,946 files in the reference corpus — so
 * `transcript` was always undefined and every voicemail fell back to the
 * synthesized `"<Type> call from <contact>"` label, both as its body and in
 * `metadata.Transcript`. 2,521 voicemails carried a transcript that was never
 * read. `note` is still accepted so an older export keeps working.
 *
 * The per-word spans are SIBLINGS that follow the full-text span, not children
 * of it, and no `full-text` element in the corpus contains a nested tag (0 of
 * 2,818), so a non-greedy match to the first `</span>` takes the whole
 * transcript and none of the timing markup.
 *
 * Returns undefined for an element that is present but empty — 297 files,
 * mostly missed calls that were never spoken into — so the caller's existing
 * fallback to the synthesized label still applies to them.
 */
function extractTranscript(raw: string): string | undefined {
  const match =
    /<span class="full-text"[^>]*>([\s\S]*?)<\/span>/i.exec(raw) ??
    /<span class="note"[^>]*>([\s\S]*?)<\/span>/i.exec(raw);
  if (!match) {
    return undefined;
  }

  const text = flattenToLine(match[1]);

  return text || undefined;
}

/**
 * The audio recording a call or voicemail HTML file points at.
 *
 * Google Voice ships the recording as a sibling .mp3 and names it twice in the
 * hAudio block — an `<audio src>` and, inside it, an `<a rel="enclosure" href>`
 * carrying the identical value:
 *
 *   <audio controls="controls" src="Name - Voicemail - 2019-06-23T04_34_22Z.mp3">
 *     <a rel="enclosure" href="Name - Voicemail - 2019-06-23T04_34_22Z.mp3">…</a>
 *   </audio>
 *
 * None of it was read. `resolveAttachment` only ever probes `.jpg/.gif/.png/
 * .jpeg`, and it is unreachable from here regardless: fileImport routes a
 * haudio file to processCallLog and RETURNS before the `<img>` attachment loop
 * runs at all. So every voicemail recording and call recording the export
 * shipped was skipped — 3,066 files name one, 2,718 of them resolve to bytes on
 * disk, and `ci.files` held no audio row from any source.
 *
 * Unlike `resolveAttachment` there is nothing to guess here: the markup states
 * the exact filename, so the only work is undoing the transport encodings.
 * The href is percent-encoded, and the filenames carry accented characters that
 * macOS stores decomposed (NFD) while the HTML names them composed (NFC) — so
 * both sides are normalised before comparing, and the resolved path is taken
 * from the DIRECTORY LISTING rather than rebuilt from the href, so the byte
 * sequence handed to `readFile` is the one the filesystem actually holds.
 *
 * Returns undefined when the file is not beside the HTML. The descriptor is
 * omitted entirely in that case rather than recorded path-less: unlike
 * imessage.ts — where chat.db knows a purged attachment's name, type and guid,
 * and "a photo was here" is worth keeping — a Voice export that is missing its
 * mp3 tells us nothing the call record does not already say.
 */
function resolveRecording(raw: string, fpath: string): AttachmentDescriptor | undefined {
  const match =
    /<audio[^>]*\ssrc="([^"]+)"/i.exec(raw) ?? /<a[^>]*\srel="enclosure"[^>]*\shref="([^"]+)"/i.exec(raw);
  if (!match) {
    return undefined;
  }

  const wanted = decodeURIComponent(match[1]).normalize('NFC');
  if (!wanted || wanted.includes('/')) {
    return undefined;
  }

  const dir = path.dirname(fpath);
  let actual: string | undefined;
  try {
    actual = fs.readdirSync(dir).find((name) => name.normalize('NFC') === wanted);
  } catch {
    return undefined;
  }

  if (!actual) {
    return undefined;
  }

  return {
    path: path.join(dir, actual),
    filename: actual,
    type: attachmentMediaKind(mimeForRecording(actual)),
    mimetype: mimeForRecording(actual),
  };
}

/** MIME for a Voice recording, which the export names only by extension. */
function mimeForRecording(filename: string): string {
  const ext = path.extname(filename).toLowerCase();

  return ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.amr' ? 'audio/amr' : '';
}

export class GoogleVoiceFileImporter implements FileImporter {
  private owner?: { name?: string; phones: string[] };

  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    let isDir = false;
    try {
      isDir = (await stat(full)).isDirectory();
    } catch {
      isDir = false;
    }

    if (isDir) {
      let score = 0;
      const entries = await readdir(full);
      if (entries.includes('Phones.vcf')) {
        score += 0.4;
      } // phonebook vCard

      if (entries.includes('Bills.html')) {
        score += 0.15;
      } // billing history file

      if (entries.includes('Calls')) {
        score += 0.6;
      } // conversations root

      // `Spam/` and `Greetings/` are siblings of `Calls/` in the reference
      // export, so their presence is corroborating evidence, same idea as
      // Bills.html above — small boosts, since `Calls` alone already clears
      // `dir_threshold` on a real export.
      if (entries.includes('Spam')) {
        score += 0.05;
      } // spam call/text/voicemail archive, same filename convention as Calls

      if (entries.includes('Greetings')) {
        score += 0.02;
      } // standalone greeting recordings only, no structured record

      // boost if any HTML conversation files exist under Calls (partial export)
      try {
        const callsPath = path.join(full, 'Calls');
        const hasHtml = (await readdir(callsPath)).some((f) => f.toLowerCase().endsWith('.html'));
        if (hasHtml) {
          score += 0.1;
        }
      } catch {
        /* ignore */
      }

      if (path.basename(full) === 'Voice') {
        score += 0.05;
      } // directory named Voice

      return { confidence: score, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return;
    }

    // attempt to parse Phones.vcf for owner numbers (very naive vCard parser)
    try {
      const vcfPath = path.join(root, 'Phones.vcf');
      if (fs.existsSync(vcfPath)) {
        const data = await fs.promises.readFile(vcfPath, 'utf8');
        const cards = data.split(/END:VCARD/); // crude
        for (const card of cards) {
          if (!card.includes('BEGIN:VCARD')) {
            continue;
          }

          // Split on \r?\n (not just \n): a spec-compliant vCard uses CRLF line
          // endings. Splitting on \n alone leaves a trailing "\r" on every line,
          // so a blank "FN:\r\n" line parses as name "\r" — a single, truthy,
          // non-empty carriage-return character — which then wins the `||`
          // fallback below over the real phone number. Trimming each line (and
          // the parsed value) keeps a genuinely blank FN falsy so the fallback
          // to phones[0] actually fires.
          const lines = card.split(/\r?\n/).map((l) => l.trim());
          const nameLine = lines.find((l) => /^FN[:;]/.test(l));
          const tels = lines.filter((l) => /^TEL[:;]/.test(l));
          const name = nameLine?.split(/:/)[1]?.trim();
          this.owner = {
            name: name || undefined,
            phones: tels.map((t) => t.split(/:/)[1]?.trim()).filter((p): p is string => Boolean(p)),
          };
          break; // take first
        }
      }
    } catch (e) {
      params.log?.('warn', 'googlevoice owner parse failed', { error: (e as Error).message });
    }

    // Conversation records live under `Calls/` and its sibling `Spam/` —
    // IDENTICAL markup and "<contact> - <Type> - <timestamp>.html" filename
    // convention (confirmed on the reference export: `Spam/` alone holds 857
    // .html files — Missed 407, Voicemail 312, Text 133, Placed 3, Received 1,
    // one "Group Conversation" file — plus 312 voicemail .mp3 recordings and 5
    // MMS .jpg attachments). Before this fix only `Calls/` was ever walked,
    // so a Google Voice export's entire spam-filtered history was silently
    // invisible to every import — not malformed, never visited.
    //
    // `Greetings/` holds only bare standalone .mp3 recordings (2 on the
    // reference export) with no companion HTML/timestamp/sender — there is no
    // structured record to build a communication item from. It is included in
    // the walk anyway because doing so is free (the `.html`-only filter below
    // already skips every file in it) and keeps `Greetings/` from silently
    // falling through if a future export ever ships a sidecar record there;
    // no item is ever fabricated from a bare audio file.
    const conversationDirs = ['Calls', 'Spam', 'Greetings']
      .map((name) => path.join(root, name))
      .filter((dir) => fs.existsSync(dir));

    if (conversationDirs.length === 0) {
      return;
    }

    for (const dir of conversationDirs) {
      // `Spam` is a directory NAME, not a per-message property in the markup
      // (though every Spam file also happens to self-label via
      // `<a rel="tag" href=".../voice#spam">`, confirmed on all 857 — this
      // just reads the cheaper, already-known signal from the walk itself).
      const fromSpam = path.basename(dir) === 'Spam';
      for await (const f of this.walkDir(dir)) {
        if (!f.toLowerCase().endsWith('.html')) {
          continue;
        }

        await this.processConversation(f, params, fromSpam);
      }
    }
  }

  private async *walkDir(root: string): AsyncGenerator<string> {
    const ents = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(root, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) {
          continue;
        }

        yield* this.walkDir(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  }

  private async processConversation(
    fpath: string,
    params: ImportParams,
    fromSpam = false,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'read google voice html failed', {
        file: path.basename(fpath),
        error: (e as Error).message,
      });

      return;
    }

    // Conversation label = the contact name/number before " - <Type> - " in the filename
    // (e.g. "+1206… - Text - 2025-11-26T…Z.html").
    //
    // ONLY when that split actually happened. `replace` returns the string
    // untouched when the pattern does not match, so a file whose name carries
    // no contact prefix — "Missed - 2025-01-15T09_30_00Z.html" — yielded the
    // whole basename, and this value is used as the CONTACT NAME further down.
    // That is where 241 Person entities named after .html files came from: a
    // filename is not a person, and the honest answer is that this file does
    // not say who the contact was.
    //
    // The copy index is dropped first (see stripCopyIndex). It sits at the very
    // END of the name, after the timestamp, so it never reached `label` either
    // way — but this same `basename` is what each message below carries as
    // `content.filename`, which IS its identity, and there the two replicas of
    // one conversation must agree.
    const basename = stripCopyIndex(path.basename(fpath));
    const label = basename
      .replace(/\s*-\s*(Text|Received|Placed|Missed|Voicemail|Recorded|Group Conversation)\b[\s\S]*$/i, '')
      .trim();
    const conversation = label && label !== basename ? label : undefined;
    const thread = threadKeyFor(fpath, conversation);

    // Call / voicemail records ("Missed"/"Placed"/"Received"/"Recorded"/"Voicemail"
    // HTML files) use a completely different markup shape: a single
    // <div class="haudio"> block (hAudio microformat) with <abbr class="published">
    // / <abbr class="duration"> and, for voicemails, a <span class="full-text">
    // transcript (see extractTranscript) — never a <div class="message"> or a
    // <q> text body. The
    // messageBlocks() below doesn't match haudio divs at all, so without this branch
    // every call/voicemail file silently produced zero items. Route them to a
    // dedicated handler instead of falling into the SMS/MMS message loop.
    if (/<div class="haudio"/i.test(raw)) {
      this.processCallLog(raw, fpath, conversation, params, fromSpam);

      return;
    }

    // Each message is a <div class="message"> … </div> block. The real Google
    // Voice HTML uses <abbr class="dt" title="ISO">, a <cite class="sender vcard">
    // with <a class="tel" href="tel:…"><span class="fn">name</span></a>, then the
    // body in <q>…</q>. Pull each field independently (order-tolerant).
    const participants: Record<string, GVEntity> = {};
    // The non-'Me' party in the file is the conversation contact; sender 'Me'
    // marks an outbound message. Track the contact so an outbound message (whose
    // only sender is 'Me') still gets a resolvable recipient. The owner (from
    // Phones.vcf) is the recipient of inbound messages.
    let contactName: string | undefined;
    let contactPhone: string | undefined;
    const owner = this.owner?.name || this.owner?.phones?.[0];
    // Which message block each inline <img> came from, keyed by the raw `src`
    // stub the attachment loop below re-reads.
    //
    // An MMS whose only content is a picture has NO <q> body, so the `continue`
    // below skips it and the picture reaches ci.communications as a standalone
    // item — 7,318 of them in the live corpus, every one with no sender, no
    // recipient and no conversation, because the attachment loop scanned the
    // whole file and had no idea which message each <img> belonged to. The
    // block DOES carry a <cite class="sender vcard">, so remember it here while
    // we still know which block we are in.
    const attachmentSenders = new Map<string, { isOutbound: boolean; sender: GVEntity }>();
    for (const block of messageBlocks(raw)) {
      // Read the sender BEFORE the no-body bail-out: an image-only MMS is still
      // a message from somebody, and both `participants` and the contact
      // tracking below are strictly better for knowing about it.
      const sender = extractSender(block);
      const isOutbound = isOwnerToken(sender);
      // The owner is NOT a participant in their own conversation. Staging them
      // here minted a `Person` literally named "Me" (see isOwnerToken), keyed
      // on the owner's own Google Voice number. `resolveCorrespondents` already
      // knows how to attribute an outbound message — `direction === 'outbound'`
      // makes the sender the appliance's `is_self` entity, and NULL until
      // onboarding declares one — so nothing is lost by staying quiet.
      if (sender.phone && !isOutbound) {
        participants[sender.phone] = sender;
      }

      if (!isOutbound) {
        if (sender.name) {
          contactName = sender.name;
        }

        if (sender.phone) {
          contactPhone = sender.phone;
        }
      }

      // Tracks every attachment shape (image/video/vcard/audio-clip; see
      // attachmentRefsIn), not just `<img>` — an MMS video or vCard is still
      // a message from somebody, exactly like an MMS image.
      for (const ref of attachmentRefsIn(block)) {
        attachmentSenders.set(ref.stub, { isOutbound, sender });
      }

      const qHtml = /<q>([\s\S]*?)<\/q>/i.exec(block)?.[1];
      if (qHtml == null) {
        continue;
      } // call log / missed call without a text body

      const text = flattenToLine(qHtml);
      const whenStr = /<(?:abbr|span) class="dt"[^>]*title="([^"]+)"/i.exec(block)?.[1];
      const ts = whenStr ? new Date(whenStr) : undefined;

      // The other end of the conversation, as the file has revealed it so far.
      const counterpart: GVEntity = {
        name: contactName || contactPhone || conversation,
        phone: contactPhone,
      };
      // Outbound: Sender='Me' is the from, the contact is the recipient (To).
      // Inbound: Sender=contact is the from; the owner is the recipient.
      const to = isOutbound ? counterpart.name : owner;
      params.pipeline.push({
        item: {
          classification: 'message',
          timestamp: ts && !isNaN(ts.getTime()) ? ts : undefined,
          intermediateLocation: fpath,
          content: {
            // `basename`, not `path.basename(fpath)`: the copy index is off it
            // (see stripCopyIndex), and this value is half of the item's dedup
            // hash. `intermediateLocation` still carries the REAL path, which
            // hashItem excludes on purpose.
            filename: basename,
            mediaType: 'text/plain',
            data: async () => Buffer.from(text),
          },
          metadata: {
            Source: 'GoogleVoice',
            // Omitted on outbound, and for the same reason iMessage omits it
            // there ("On outbound, handle_id is NULL — self has no handle
            // row"): `push/inputs.ts` copies this straight into
            // `participants_metadata.from`, which `PersonLinkStage` turns into
            // a Person. `Direction: 'outgoing'` plus the counterpart edge
            // already say who sent this; the owner token would only say it
            // again, wrongly, as a name.
            Sender: isOutbound ? undefined : sender.name || sender.phone || undefined,
            Conversation: conversation,
            // The grouping key, separate from Conversation because Conversation
            // doubles as the contact NAME and must stay undefined when the
            // filename names nobody. push/inputs.ts toCommunicationInput reads
            // ThreadId first, so this is what lands in
            // ci.communications.thread_id. See threadKeyFor.
            ThreadId: thread,
            Text: text || undefined,
            Direction: isOutbound ? 'outgoing' : 'incoming',
            To: to || undefined,
            // Provenance, not a schema field: this file has no spam/ham
            // distinction anywhere downstream, so the item is staged exactly
            // like an ordinary message — this just records where Google
            // Voice's own filter filed it, in case a future consumer wants to
            // exclude or specially surface it.
            ...(fromSpam ? { Spam: true } : {}),
          },
        },
        edges: counterpartEdges(isOutbound, sender, counterpart),
      });
    }

    // Distinct participants → one contact entity each (per file).
    for (const p of Object.values(participants)) {
      if (!p.phone && !p.name) {
        continue;
      }

      params.pipeline.push({
        entity: {
          type: participantType(p),
          name: p.name || p.phone,
          attributes: p.phone ? [{ name: 'phone', value: p.phone, identity: true } as EntityAttribute] : [],
        },
      });
    }

    // Attachments: image (existing) + video/vcard/audio-clip (see
    // attachmentRefsIn). `dirEntries` is read ONCE per conversation file and
    // threaded into every resolveAttachment call — both for the NFC-normalized
    // comparison resolveRecording already does correctly, and so the
    // truncation-collision fallback below doesn't re-list the directory.
    const dir = path.dirname(fpath);
    const basenameNoExt = basename.replace(/\.[^.]+$/, '');
    let dirEntries: string[];
    try {
      dirEntries = fs.readdirSync(dir);
    } catch {
      dirEntries = [];
    }

    const pushedAttachmentPaths = new Set<string>();
    // Whether this conversation referenced any image stub at all, and whether
    // any of them actually resolved — the two facts pushCollapsedAttachments
    // needs to decide "this is a genuine truncation collision", not merely
    // "this conversation has no pictures" or "one picture happens to be
    // missing".
    let sawImageStub = false;
    let anyImageResolved = false;

    for (const ref of attachmentRefsIn(raw)) {
      const filename = resolveAttachment(ref.stub, dir, basenameNoExt, dirEntries);
      if (ref.kind === 'image') {
        sawImageStub = true;
        anyImageResolved = anyImageResolved || Boolean(filename);
      }

      if (!filename) {
        // Image misses stay silent, as before this fix — the pre-existing
        // behavior is intentionally preserved, since the truncation-collision
        // fallback below is what recovers the actual bytes for the case that
        // matters (a long conversation name). Video/vcard/audio-clip misses
        // have no such fallback, so an unresolved one is a real, otherwise
        // invisible loss and must be reported.
        if (ref.kind !== 'image') {
          params.pipeline.drop?.('googlevoice_attachment_missing', ref.stub);
        }

        continue;
      }

      // Who this attachment was between. `attachmentSenders` has the answer
      // whenever the reference sat inside a <div class="message"> block —
      // which is where Google Voice puts every MMS attachment — so an
      // attachment-only MMS is attributed exactly the way a text message in
      // the same file is, rather than landing as one from nobody.
      //
      // No entry means the stub was not inside any message block we could
      // parse. `Conversation` still names the thread the file is, but nothing
      // here says which way the attachment travelled, so no Sender / To / edge
      // is claimed: a filename label is not evidence of authorship.
      const attributed = attachmentSenders.get(ref.stub);
      const counterpart: GVEntity = {
        name: contactName || contactPhone || conversation,
        phone: contactPhone,
      };
      const mimetype = mimeForAttachment(filename);
      const kind = attachmentMediaKind(mimetype);
      pushedAttachmentPaths.add(filename);
      const item = {
        classification: 'message',
        timestamp: tsFromAttachmentFilename(filename),
        intermediateLocation: filename,
        content: {
          filename: path.basename(filename),
          mediaType: '',
          data: async () => fs.promises.readFile(filename),
        },
        // An MMS attachment belongs to the conversation whose HTML file
        // referenced it. It carried neither key before, so every one of the
        // 7,427 attachment rows on the live database landed with thread_id
        // NULL and detached from the conversation it is part of. The keys come
        // from the PARENT file (fpath), never from the attachment's own name —
        // Google Voice suffixes those with a per-message index ("… -1-1.jpg"),
        // which would mint a separate thread per attachment.
        metadata: {
          Source: 'GoogleVoice',
          Attachment: kind,
          Conversation: conversation,
          ThreadId: thread,
          // Attribution from the `<div class="message">` block the reference
          // sat in. Orthogonal to the thread key above: the thread says WHICH
          // conversation, this says who sent it and which way it travelled.
          ...(attributed
            ? {
                // Same rule as the message loop above: the owner token is not a
                // sender name, so an outbound attachment names nobody as `from`
                // and lets direction carry the authorship.
                Sender: attributed.isOutbound
                  ? undefined
                  : attributed.sender.name || attributed.sender.phone || undefined,
                Direction: attributed.isOutbound ? 'outgoing' : 'incoming',
                To: (attributed.isOutbound ? counterpart.name : owner) || undefined,
              }
            : {}),
          ...(fromSpam ? { Spam: true } : {}),
          // MediaStage's upload leg never sees this item: `content.mediaType`
          // is deliberately left '' (see below) so `isMediaItem()` stays
          // false and the primary media predicate skips it. Only the
          // ATTACHMENT leg (gated on MediaAttachments, same as a voicemail
          // recording above) uploads the bytes and links them to a message —
          // uploading via BOTH legs would produce two ci.files rows for the
          // same bytes, one of them orphaned.
          MediaAttachments: [
            {
              path: filename,
              filename: path.basename(filename),
              type: kind,
              mimetype,
            },
          ],
        },
      };
      params.pipeline.push({
        item,
        edges: attributed
          ? counterpartEdges(attributed.isOutbound, attributed.sender, counterpart)
          : undefined,
      });
    }

    // Only reached when EVERY image stub in this conversation failed to
    // resolve AND the name is long enough to have actually collided (see
    // pushCollapsedAttachments) — never for a conversation with no pictures,
    // and never for an ordinary single missing file.
    if (sawImageStub && !anyImageResolved && basenameNoExt.length >= 45) {
      pushCollapsedAttachments(
        params,
        fpath,
        dir,
        dirEntries,
        basenameNoExt,
        conversation,
        thread,
        pushedAttachmentPaths,
        fromSpam,
      );
    }
  }

  // Call / voicemail record (hAudio microformat): one <div class="haudio"> per
  // file. Shape (matching real Google Voice Takeout exports):
  //   <div class="haudio">
  //     <span class="fn">Missed call from <a class="tel" href="tel:+1…">
  //       <span class="fn">Name</span></a></span>
  //     <abbr class="published" title="2025-01-15T09:30:00.000Z">…</abbr>
  //     <abbr class="duration" title="00:01:15">(00:01:15)</abbr>
  //     <span class="description"><span class="full-text">transcript</span>
  //       …per-word <span class="word …"> spans…</span>       (voicemail only)
  //   </div>
  // Call direction/type (Missed/Placed/Received/Voicemail/Recorded) is most
  // reliably read from the filename — Google Voice names each call-log file
  // "<contact> - <Type> - <timestamp>.html", and this file already parses that
  // suffix for `conversation` above — rather than a class name in the markup,
  // which isn't consistent across call types. Emitted as classification 'call'
  // to match the shape sms_backup_restore.ts already uses for real call
  // records (Contact/Number/Duration/DurationUnit/Direction/Source/Description).
  private processCallLog(
    raw: string,
    fpath: string,
    conversation: string | undefined,
    params: ImportParams,
    fromSpam = false,
  ): void {
    const publishedMatch = /<abbr class="published"[^>]*\b(?:title|datetime)="([^"]+)"/i.exec(raw);
    const whenStr = publishedMatch?.[1];
    const ts = whenStr ? new Date(whenStr) : undefined;

    const durationMatch = /<abbr class="duration"[^>]*\b(?:title|datetime)="([^"]+)"/i.exec(raw);
    const durationSeconds = durationMatch ? parseDurationToSeconds(durationMatch[1]) : undefined;

    const typeMatch = /-\s*(Missed|Placed|Received|Voicemail|Recorded)\b/i.exec(path.basename(fpath));
    const callType = typeMatch ? typeMatch[1] : 'Unknown';
    const directionMap: Record<string, string> = {
      missed: 'missed',
      placed: 'outgoing',
      received: 'incoming',
      voicemail: 'incoming',
      recorded: 'incoming',
    };
    const direction = directionMap[callType.toLowerCase()] || 'unknown';

    // Contact: prefer a tel/fn pair inside the haudio block (same markup the
    // <q> message path already knows how to read), fall back to the filename
    // label parsed as `conversation` above.
    //
    // A "Placed" call's haudio block can name the OWNER rather than the person
    // called, in the same `Me` token the message path reads (see isOwnerToken).
    // `Contact` is what `push/inputs.ts` reads FIRST for a communication's
    // `from`, ahead of `Sender`, so letting the token through here would mint
    // the same fake Person from the call lane that the message lane used to.
    // The filename label is the honest answer for such a file — it names the
    // other end of the call, which is what `Contact` means.
    //
    // Nothing on the live corpus has hit this arm (all 133,859 owner-attributed
    // rows there are `communication_type = 'chat'`), so it is a guard rather
    // than a repair: one rule for one token, in every markup shape this
    // importer reads it from, so the two lanes cannot drift.
    const rawSender = extractSender(raw);
    const sender: GVEntity = isOwnerToken(rawSender) ? {} : rawSender;
    const contact = sender.name || sender.phone || conversation;

    const transcript = extractTranscript(raw);
    const recording = resolveRecording(raw, fpath);

    const preposition = direction === 'outgoing' ? 'to' : 'from';
    const contentStr = `${callType} call ${preposition} ${contact || 'unknown'}`;

    params.pipeline.push({
      item: {
        classification: 'call',
        timestamp: ts && !isNaN(ts.getTime()) ? ts : undefined,
        intermediateLocation: fpath,
        content: {
          // Copy index removed (see stripCopyIndex). A call log carries no
          // `item.id`, so this filename plus the timestamp IS the item's dedup
          // key — with the index left on, one call exported twice becomes two
          // rows with two different provenance triples, which no unique index
          // downstream can merge again.
          filename: stripCopyIndex(path.basename(fpath)),
          mediaType: 'text/plain',
          data: async () => Buffer.from(transcript || contentStr),
        },
        metadata: {
          Source: 'GoogleVoice',
          Contact: contact || undefined,
          Number: sender.phone || undefined,
          Conversation: conversation,
          // Same split as the message path: Conversation is the contact label
          // (undefined when the filename names nobody), ThreadId is the
          // grouping key and always resolves. See threadKeyFor.
          ThreadId: threadKeyFor(fpath, conversation),
          CallType: callType,
          Direction: direction,
          Duration: durationSeconds,
          DurationUnit: durationSeconds != null ? 'seconds' : undefined,
          Transcript: transcript || undefined,
          Description: contentStr,
          ...(recording && { MediaAttachments: [recording] }),
          ...(fromSpam ? { Spam: true } : {}),
        },
      },
    });

    if (sender.phone || sender.name) {
      params.pipeline.push({
        entity: {
          type: participantType(sender),
          name: sender.name || sender.phone,
          attributes: sender.phone
            ? [{ name: 'phone', value: sender.phone, identity: true } as EntityAttribute]
            : [],
        },
      });
    }
  }
}

/**
 * The `participant` edge naming the other end of one Google Voice message.
 *
 * This file used to stage NO edges at all — every message travelled as raw
 * `Sender`/`To` strings in metadata and depended entirely on a post-load sweep
 * reading `participants_metadata` to turn them into people. Anything that
 * reached ci.communications without those strings (image-only MMS: 7,318 rows)
 * had no second chance, and PushStage's `resolveCorrespondents` had nothing to
 * work with either, so `from_entity_id` / `to_entity_ids` were left for someone
 * else to fill. An edge says the same thing the metadata says, in the shape the
 * push already knows how to resolve.
 *
 * Asymmetric on purpose:
 *
 * - OUTBOUND — the counterpart is a RECIPIENT, and `To` already falls back to
 *   the conversation label parsed off the filename, so the edge may use it too.
 * - INBOUND — the counterpart is the SENDER, and an edge is emitted only when
 *   the block's `<cite class="sender vcard">` actually named somebody. A
 *   filename is not evidence of who wrote a message; guessing there is how this
 *   importer previously minted 241 Person entities named after .html files.
 */
function counterpartEdges(
  isOutbound: boolean,
  sender: GVEntity,
  counterpart: GVEntity,
): Relationship[] | undefined {
  const name = isOutbound ? counterpart.name : sender.name || sender.phone;
  if (!name) {
    return undefined;
  }

  // The phone is an IDENTITY attribute (see imessage.ts contactEntity): without
  // it the entity is keyed by name and never gets a ci.entity_identifiers row,
  // so it can never be cross-referenced with the same number from a vCard.
  const phone = isOutbound ? counterpart.phone : sender.phone;

  return [
    {
      relation: 'participant',
      to: {
        entity: {
          // Same rule as the two entity pushes above, and it matters most here:
          // this edge is the only one of the three that has never run against
          // the QA corpus, so its hard-coded 'contact' was a latent `Person`
          // named "411" waiting for the next import rather than a row anyone
          // could see. See participantType.
          type: participantType({ name, phone }),
          name,
          attributes: phone ? [{ name: 'phone', value: phone, identity: true } as EntityAttribute] : [],
        },
      },
      metadata: { direction: isOutbound ? 'outgoing' : 'incoming' },
    },
  ];
}

/**
 * The inner HTML of every `<div class="message">` block, each with its FULL
 * extent.
 *
 * Not a regex, because the extent is not regular. A real Google Voice MMS
 * wraps every attachment in its own sibling div inside the message:
 *
 *   <div class="message">…<q></q>
 *     <div><img src="…-7-1"/></div> <div><img src="…-7-2"/></div> …
 *   </div>
 *
 * The lazy `([\s\S]*?)<\/div>` this replaced stopped at the FIRST `</div>`,
 * which closes the first attachment wrapper — so the captured block ended
 * after image 1 and images 2..N sat outside every block the parser could see.
 * `attachmentSenders` therefore had no entry for them, and they reached
 * ci.communications with no sender, no recipient and no direction. On the live
 * corpus that is 274 rows, and the signature is exact: every one is an
 * attachment whose per-message index is >= 2 (168 x "-2", 48 x "-3", … 1 x
 * "-15") and NOT ONE has index 1.
 *
 * {@link matchingDivCloseIndex} (./htmlBlocks) counts `<div`/`</div>` to find
 * the real close. Scanning resumes AFTER the block rather than inside it: a
 * message div never nests another message div, and re-entering one would
 * attribute the same attachments twice.
 */
function messageBlocks(raw: string): string[] {
  const blocks: string[] = [];
  const openRegex = /<div class="message[^"]*">/gi;
  let open: RegExpExecArray | null;
  while ((open = openRegex.exec(raw)) !== null) {
    const start = open.index + open[0].length;
    const end = matchingDivCloseIndex(raw, start);
    blocks.push(raw.slice(start, end));
    openRegex.lastIndex = end;
  }

  return blocks;
}

// Named entities actually seen in the reference corpus (scanned across all
// 59,748 HTML files: `grep -ohE '&[a-zA-Z]+;' | sort | uniq -c`) —
// &aacute; 1,694, &ntilde; 647, &rsquo;/&lsquo; 462 each, &iacute; 66,
// &eacute; 46, &iuml; 3 — plus the accented-vowel and curly-quote siblings
// that did not happen to appear in THIS corpus but follow the same Latin-1
// entity set a name can plausibly carry. Before this, `decodeHtml` handled
// only numeric refs and the four XML entities, and was never even called on
// an `<img>`/`<a>` stub (see resolveAttachment) — so every accented filename
// failed a raw `fs.existsSync` string compare against the un-decoded markup.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  aacute: 'á',
  Aacute: 'Á',
  eacute: 'é',
  Eacute: 'É',
  iacute: 'í',
  Iacute: 'Í',
  oacute: 'ó',
  Oacute: 'Ó',
  uacute: 'ú',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  iuml: 'ï',
  Iuml: 'Ï',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeHtml(h: string): string {
  return h
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

// A voicemail transcript / SMS body has no paragraph structure of its own —
// any newline the shared htmlToText introduces at a tag boundary is markup,
// not something the caller said, so it collapses to a flat line.
function flattenToLine(html: string): string {
  return htmlToText(html).replace(/\s+/g, ' ').trim();
}

function extractSender(block: string): GVEntity {
  // Real Google Voice exports wrap the OUTBOUND sender ("Me") in
  // <abbr class="fn" title="">Me</abbr> and the INBOUND contact in
  // <span class="fn">Name</span>. The original regex only matched <span>, so
  // every outbound message landed with sender=undefined and was misclassified
  // as inbound — accept both tags.
  //
  // The <a class="tel"> form is tried FIRST because it is unambiguous: the name
  // nested inside the phone-number anchor is the contact and nothing else. The
  // bare `fn` match below is the fallback, and it is the one that can pick up a
  // heading.
  const telName =
    /<a class="tel"[^>]*>[\s\S]*?<(?:span|abbr) class="fn"(?:\s[^>]*)?>([^<]*)<\/(?:span|abbr)>/i.exec(block);
  const nameMatch = telName ?? /<(?:span|abbr) class="fn"(?:\s[^>]*)?>([^<]*)<\/(?:span|abbr)>/i.exec(block);
  const telMatch = /<a class="tel" href="tel:([^"']+)"/i.exec(block);

  // Strip the heading and collapse the whitespace it leaves behind. What
  // remains is either the real name or nothing — and nothing is the honest
  // answer, since a caller the export does not name has no name to record.
  // `stripCallLogHeading` is the graph domain's shared rule (participantSanity),
  // not a private copy: the same pattern that strips the heading HERE is the one
  // that refuses it downstream if a heading ever reaches a Person minter, and
  // two copies would drift the moment either side gained a verb.
  const raw = nameMatch ? stripCallLogHeading(decodeHtml(nameMatch[1])) : undefined;

  return { name: raw ? raw : undefined, phone: telMatch?.[1] };
}

// Google Voice call-log <abbr class="duration"> values have been observed in
// both a plain "H:MM:SS" / "HH:MM:SS" clock format and an ISO-8601 duration
// ("PT1M15S"). Accept either, plus a bare integer (already seconds), rather
// than assuming one specific export variant.
function parseDurationToSeconds(raw: string): number | undefined {
  const clock = /^(\d+):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (clock) {
    return +clock[1] * 3600 + +clock[2] * 60 + +clock[3];
  }

  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(raw.trim());
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return +(iso[1] || 0) * 3600 + +(iso[2] || 0) * 60 + +(iso[3] || 0);
  }

  const bare = /^\d+$/.exec(raw.trim());
  if (bare) {
    return +bare[0];
  }

  return undefined;
}

/** Every extension an MMS attachment (image, video clip, audio clip, vCard) resolves to. */
const ATTACHMENT_EXTENSIONS = ['.jpg', '.gif', '.png', '.jpeg', '.3gp', '.mp4', '.amr', '.vcf'];

// Matches the trailing "T##_##_##Z" + per-message "-N" / "-N-M" index a real
// export's own attachment stub ends with, e.g. "…2018-08-03T17_08_26Z-9-1" ->
// captures "-9-1". Used only to REBUILD a candidate from the container's own
// basename (see resolveAttachment case 3) — never to validate the stub alone,
// since the date/hour digits before the "T" are not part of this match.
const ATTACHMENT_SUFFIX_RE = /T\d{2}_\d{2}_\d{2}Z((?:-\d+)*)$/;

/**
 * Resolve one attachment `stub` (the raw `<img src>` / `<a href>` / `<audio
 * src>` value) to the real file beside the conversation's HTML. Three
 * strategies, tried in order, because a single `fs.existsSync(stub + ext)` —
 * this function's entire body until this fix — missed real, present files in
 * (at least) two confirmed ways on the reference corpus:
 *
 * 1. Verbatim (decoded, NFC-normalized) match. Handles the common case, and
 *    now also the corpus's 1,694 `&aacute;`-etc. cases (see decodeHtml): the
 *    stub is HTML-entity-encoded but the file on disk never is, e.g.
 *    `<img src="Michelle Ju&aacute;rez - Text - …-20-1">` beside the real
 *    "Michelle Juárez - Text - …-20-1.jpg".
 *
 * 2. Rebuilt from the CONTAINING conversation file's own basename
 *    (`basenameNoExt`, stripped of its copy index by the caller) plus the
 *    stub's own trailing timestamp+index suffix. Google Voice sometimes
 *    exports an `<img>` naming the contact by NAME after the export had
 *    already resolved it, while the HTML FILE itself is still named by the
 *    phone number it had at export time — confirmed real:
 *    "+13108748112 - Text - 2018-08-03T17_08_26Z.html" contains
 *    `<img src="Steve Raymond - Text - 2018-08-03T17_08_26Z-9-1">`, and the
 *    real file on disk is "+13108748112 - Text - …-9-1.jpg". The stub's own
 *    name/number prefix is therefore not reliable — only its timestamp+index
 *    suffix is — so this rebuilds from the file's own name instead.
 *
 * Directory comparison is NFC-normalized on both sides via a single
 * `readdir()` the caller passes in (`dirEntries`), the same pattern
 * `resolveRecording` already uses correctly: a raw `fs.existsSync` string
 * concat cannot see past an NFD-vs-NFC composition difference, which is
 * routine on a macOS/Drive-synced corpus.
 *
 * Returns undefined — not a guess — when neither strategy finds a real file.
 * The caller's truncation-collision fallback (see `pushCollapsedAttachments`)
 * is what recovers the remaining case, a genuine filename COLLISION at the
 * export/filesystem level rather than a lookup miss.
 */
function resolveAttachment(
  stub: string,
  dir: string,
  basenameNoExt: string,
  dirEntries: readonly string[],
): string | undefined {
  const normalizedEntries = dirEntries.map((name) => ({ name, nfc: name.normalize('NFC') }));
  const findExact = (base: string): string | undefined => {
    for (const ext of ATTACHMENT_EXTENSIONS) {
      const wanted = `${base}${ext}`;
      const hit = normalizedEntries.find((e) => e.nfc === wanted);
      if (hit) {
        return hit.name;
      }
    }

    return undefined;
  };

  const decoded = decodeHtml(stub).normalize('NFC');

  const direct = findExact(decoded);
  if (direct) {
    return path.join(dir, direct);
  }

  const suffixMatch = ATTACHMENT_SUFFIX_RE.exec(decoded);
  if (suffixMatch) {
    const rebuilt = `${basenameNoExt}${suffixMatch[1]}`;
    if (rebuilt !== decoded) {
      const viaBasename = findExact(rebuilt);
      if (viaBasename) {
        return path.join(dir, viaBasename);
      }
    }
  }

  return undefined;
}

/** MIME for an MMS attachment, which resolveAttachment names only by extension. */
function mimeForAttachment(filename: string): string {
  const ext = path.extname(filename).toLowerCase();

  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.png':
      return 'image/png';
    // Video clip. Confirmed 148 `.3gp` + 13 `.mp4` files in the reference
    // corpus, referenced via `<a class="video" href="STUB">Video
    // attachment</a>` — a shape the old `<img>`-only scanner never matched at
    // all (see attachmentRefsIn).
    case '.3gp':
      return 'video/3gpp';
    case '.mp4':
      return 'video/mp4';
    // Voice/audio MMS clip. 3 `.amr` files in the corpus, referenced by a
    // bare `<audio src="STUB"></audio>` inside the message block — distinct
    // from a voicemail's `<audio controls… ><a rel="enclosure">` shape (see
    // resolveRecording), which only occurs in a haudio CALL file and never
    // reaches this scanner.
    case '.amr':
      return 'audio/amr';
    // Contact-card MMS attachment. 7 `.vcf` files in the corpus, referenced
    // via `<a class="vcard" href="STUB">Contact card attachment</a>`.
    case '.vcf':
      return 'text/vcard';
    default:
      return '';
  }
}

type AttachmentRefKind = 'image' | 'video' | 'vcard' | 'audio';

/**
 * Every attachment-reference shape a real Google Voice message body emits,
 * scanned in one pass so the sender-tracking loop and the resolve-and-push
 * loop stay in sync (see the two call sites below).
 *
 * Before this, the ONLY shape recognized anywhere in this file was
 * `<img src="STUB">`. Google Voice also emits:
 *   - `<a class="video" href="STUB">Video attachment</a>`  — 128 files in the
 *     reference corpus (`grep -rl 'class="video"'`).
 *   - `<a class="vcard" href="STUB">Contact card attachment</a>` — 6 files.
 *   - `<audio src="STUB"></audio>` (no `controls`, no `rel="enclosure"`) for
 *     an MMS voice-clip reply — 3 `.amr` files. This is a DIFFERENT shape
 *     from a voicemail's recording markup (see resolveRecording) and only
 *     ever appears inside a `<div class="message">`, never a haudio block —
 *     fileImport routes haudio files to processCallLog before this scanner
 *     runs, so there is no ambiguity between the two `<audio>` shapes.
 * None of the three were scanned for at all — 100% of non-image MMS
 * attachments (video/audio-clip/vcard) reached neither `attachmentSenders`
 * nor the resolve-and-push loop, and were silently absent from every export.
 */
const ATTACHMENT_REF_RE =
  /<img[^>]*\ssrc="([^"]+)"|<a class="(video|vcard)"[^>]*\shref="([^"]+)"|<audio[^>]*\ssrc="([^"]+)"/gi;

function attachmentRefsIn(html: string): Array<{ stub: string; kind: AttachmentRefKind }> {
  const refs: Array<{ stub: string; kind: AttachmentRefKind }> = [];
  const re = new RegExp(ATTACHMENT_REF_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      refs.push({ stub: m[1], kind: 'image' });
    } else if (m[2] !== undefined) {
      refs.push({ stub: m[3], kind: m[2].toLowerCase() as 'video' | 'vcard' });
    } else if (m[4] !== undefined) {
      refs.push({ stub: m[4], kind: 'audio' });
    }
  }

  return refs;
}

/**
 * Recover attachment BYTES, unattributed, for a conversation whose own
 * filename stem is long enough that Google Voice's exporter collapsed EVERY
 * attachment for it onto the identical truncated name — and Drive/the
 * filesystem then disambiguated with its own "(1)", "(2)"… suffix, destroying
 * the per-message "-N-M" index at the SOURCE, before this parser ever sees a
 * byte of it.
 *
 * Confirmed real example: "Alexandra Leonidova - Text -
 * 2018-07-29T03_31_30Z.html" (a 49-char stem) references five distinct image
 * stubs ("-2-1", "-16-1", "-18-1", "-23-1", "-31-1"), and the corpus holds
 * exactly five files for the whole conversation: "…Z-.jpg" plus
 * "…Z-(1).jpg" through "…Z-(4).jpg" — no suffix survives on disk to say which
 * is which.
 *
 * Per this file's standing rule against fabricated attribution (see "a
 * filename label is not evidence of authorship" in the resolve-and-push loop
 * below), guessing a mapping here would be worse than admitting there isn't
 * one. So each distinct collapsed file is pushed exactly once, UNATTRIBUTED
 * (no Sender/Direction/To/edge) — the same shape that loop already uses when
 * a stub sits outside every message block.
 *
 * Not gated by classifyDrops/`drop()`: the bytes ARE recovered, so this is
 * not a loss to count — but it is a real thread-level compromise (five
 * pictures with no per-message home), so it is logged once per conversation
 * rather than passing silently.
 */
function pushCollapsedAttachments(
  params: ImportParams,
  fpath: string,
  dir: string,
  dirEntries: readonly string[],
  basenameNoExt: string,
  conversation: string | undefined,
  thread: string,
  alreadyPushed: ReadonlySet<string>,
  fromSpam = false,
): void {
  const escaped = basenameNoExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const collisionRe = new RegExp(`^${escaped}-(?:\\(\\d+\\))?\\.(jpg|gif|png|jpeg|3gp|mp4|amr)$`, 'i');
  const matches = dirEntries.filter((name) => collisionRe.test(name) && !alreadyPushed.has(path.join(dir, name)));

  if (matches.length === 0) {
    return;
  }

  params.log?.('warn', 'googlevoice: attachment truncation collision, recovered unattributed', {
    file: path.basename(fpath),
    recovered: matches.length,
  });

  for (const name of matches) {
    const filename = path.join(dir, name);
    const mimetype = mimeForAttachment(filename);
    const kind = attachmentMediaKind(mimetype);
    params.pipeline.push({
      item: {
        classification: 'message',
        timestamp: tsFromAttachmentFilename(filename),
        intermediateLocation: filename,
        content: {
          filename: name,
          mediaType: '',
          data: async () => fs.promises.readFile(filename),
        },
        metadata: {
          Source: 'GoogleVoice',
          Attachment: kind,
          Conversation: conversation,
          ThreadId: thread,
          MediaAttachments: [{ path: filename, filename: name, type: kind, mimetype }],
          ...(fromSpam ? { Spam: true } : {}),
        },
      },
    });
  }
}

// Attachment filenames embed the real send time, e.g.
// "Victoria Grant - Text - 2019-07-06T18_16_10Z-23-1.jpg" (colons swapped for
// underscores to be filename-safe). Without this, every image attachment got
// timestamp: undefined and CI-Server defaulted to ingestion time.
const TS_IN_FILENAME_RE = /(\d{4}-\d{2}-\d{2})T(\d{2})_(\d{2})_(\d{2})Z/;
function tsFromAttachmentFilename(filename: string): Date | undefined {
  const m = TS_IN_FILENAME_RE.exec(path.basename(filename));
  if (!m) {
    return undefined;
  }

  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);

  return isNaN(d.getTime()) ? undefined : d;
}

registerDataSource({
  name: 'google_voice',
  title: 'Google Voice',
  icon: 'google_voice.svg',
  description: 'Google Voice HTML conversation exports (simplified)',
  newOptions: () => ({}) as GoogleVoiceOptions,
  newFileImporter: () => new GoogleVoiceFileImporter(),
});
