import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ATTACHMENTS_DIRNAME,
  extractAttachmentToFile,
  sanitizeAttachmentFilename,
} from '../attachment_extract';
import { EmailFileImporter } from '../email';
import { GmailFileImporter } from '../gmail';
import type { ImportParams } from '../timeline';

import { metaAttachments, type EmittedGraph } from './support/emitted';

/**
 * Attachment extraction, restored from CI-Import-Tools.
 *
 * The incident behind it: an email's attachment descriptor pointed at the MBOX
 * CONTAINER rather than at the attachment, so a 5.3 GB mbox was what the upload
 * leg tried to send for a 30 KB image. Every case here is a guard on that —
 * the descriptor must name a small extracted file, under the drop, holding
 * exactly the decoded bytes.
 *
 * Upstream this file had a seventh case, asserting that `persistGraphs`
 * RETAINED the extracted file into a media store so the bytes survived inbox
 * cleanup. It is not restored: media retention is the push's Minio leg, which
 * does not exist yet. It belongs with that work, not here — restoring it now
 * would mean asserting a feature into existence.
 */

const ATTACHMENT_BYTES = Buffer.from('PNG-ATTACHMENT-BYTES-0123456789', 'utf8');

/** A Takeout-style drop: `<root>/_drops/d1/sample.mbox`, one base64 image attachment. */
function makeDropWithMbox(opts: { emptyAttachment?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-att-inbox-'));
  const dropDir = path.join(root, '_drops', 'd1');

  fs.mkdirSync(dropDir, { recursive: true });

  const mboxPath = path.join(dropDir, 'sample.mbox');
  const boundary = 'XYZBOUNDARY';
  const base64 = opts.emptyAttachment ? '' : ATTACHMENT_BYTES.toString('base64');

  const message =
    `From someone@example.com Fri Jan 03 12:00:00 2025\n` +
    `Subject: Att Sample\n` +
    `Date: Fri, 03 Jan 2025 12:00:00 +0000\n` +
    `From: Alice <alice@example.com>\n` +
    `To: Bob <bob@example.com>\n` +
    `Message-ID: <id1@example.com>\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\n\n` +
    `--${boundary}\nContent-Type: text/plain\n\nPlain body\n` +
    `--${boundary}\nContent-Type: image/png; name="pic.png"\n` +
    `Content-Transfer-Encoding: base64\n` +
    `Content-Disposition: attachment; filename="pic.png"\n\n${base64}\n` +
    `--${boundary}--\n`;

  fs.writeFileSync(mboxPath, message, 'utf8');

  return { root, dropDir, mboxPath };
}

async function importMbox(
  importer: GmailFileImporter | EmailFileImporter,
  mboxPath: string,
): Promise<EmittedGraph[]> {
  const pipeline: EmittedGraph[] = [];

  await importer.fileImport({}, { filename: path.basename(mboxPath), fullPath: mboxPath }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline.filter((graph) => graph.item);
}

/** The email item, with the assertion that attachments are descriptors and not sub-items. */
function mailOf(graphs: EmittedGraph[]) {
  const main = graphs.find((graph) => graph.item.metadata.Subject === 'Att Sample');

  expect(main).toBeTruthy();
  // Attachments ride as metadata descriptors on the message; an `attachment`
  // edge would mean the old sub-item shape came back.
  expect(main!.edges?.some((edge) => edge.relation === 'attachment')).toBeFalsy();

  return main!.item;
}

describe('email attachment extraction (container-copy incident fix)', () => {
  it('gmail: the descriptor names an extracted file under the drop, not the mbox container', async () => {
    const { dropDir, mboxPath } = makeDropWithMbox();
    const mail = mailOf(await importMbox(new GmailFileImporter(), mboxPath));
    const attachments = metaAttachments(mail.metadata.MediaAttachments);

    expect(attachments).toHaveLength(1);

    const location = attachments[0].path as string;

    expect(location).toBeTruthy();
    // The whole incident: this used to be the 5.3 GB container.
    expect(location).not.toBe(mboxPath);
    expect(location.startsWith(path.join(dropDir, ATTACHMENTS_DIRNAME) + path.sep)).toBe(true);
    // And it holds exactly the decoded attachment bytes.
    expect(fs.readFileSync(location).equals(ATTACHMENT_BYTES)).toBe(true);
    // basename === descriptor filename, so an upload carries the human name.
    expect(path.basename(location)).toBe(attachments[0].filename);
    expect(attachments[0].type).toBe('image');
    expect(attachments[0].mimetype).toBe('image/png');
  });

  it('gmail: a zero-byte attachment leaves no descriptor at all', async () => {
    // Better nothing than a descriptor pointing at a container: a dangling path
    // is what the upload leg would then try to send.
    const { mboxPath } = makeDropWithMbox({ emptyAttachment: true });
    const mail = mailOf(await importMbox(new GmailFileImporter(), mboxPath));

    expect(mail.metadata.MediaAttachments).toBeUndefined();
  });

  it('email (the generic .mbox twin): extracts the same way', async () => {
    // Two importers read .mbox; a fix applied to one and not the other is how
    // the incident half-returns.
    const { dropDir, mboxPath } = makeDropWithMbox();
    const mail = mailOf(await importMbox(new EmailFileImporter(), mboxPath));
    const attachments = metaAttachments(mail.metadata.MediaAttachments);

    expect(attachments).toHaveLength(1);

    const location = attachments[0].path as string;

    expect(location).not.toBe(mboxPath);
    expect(location.startsWith(path.join(dropDir, ATTACHMENTS_DIRNAME) + path.sep)).toBe(true);
    expect(fs.readFileSync(location).equals(ATTACHMENT_BYTES)).toBe(true);
  });

  it('dedups on content: a re-extract reuses the existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-att-dedup-'));
    const container = path.join(dir, 'a.mbox');

    fs.writeFileSync(container, 'x');

    const attachment = { filename: 'pic.png', data: ATTACHMENT_BYTES };
    const first = extractAttachmentToFile(container, attachment)!;

    // Tamper the extracted copy: identical content must resolve to the same
    // path and skip the write, so the existing file survives untouched.
    fs.writeFileSync(first, 'TAMPERED');

    const second = extractAttachmentToFile(container, attachment)!;

    expect(second).toBe(first);
    expect(fs.readFileSync(first, 'utf8')).toBe('TAMPERED');
  });

  it('sanitizes hostile or absent filenames', () => {
    // The name comes from the message, so it is attacker-controlled text that
    // ends up as a path segment.
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentFilename('we<i>rd:"na|me?*.png')).toBe('we_i_rd__na_me__.png');
    expect(sanitizeAttachmentFilename(undefined)).toBe('attachment');
    expect(sanitizeAttachmentFilename('   ')).toBe('attachment');
    // `basename` leaves these intact and no character class touches them, so
    // the sanitizer used to return a traversal segment — harmless as a filename
    // (EISDIR) and a real escape for a caller that uses this for a DIRECTORY.
    expect(sanitizeAttachmentFilename('..')).toBe('attachment');
    expect(sanitizeAttachmentFilename('.')).toBe('attachment');
    expect(sanitizeAttachmentFilename('../../x/..')).toBe('attachment');

    const monster = `${'a'.repeat(300)}.png`;
    const out = sanitizeAttachmentFilename(monster);

    expect(out.length).toBe(128);
    expect(out.endsWith('.png')).toBe(true);
  });
});
