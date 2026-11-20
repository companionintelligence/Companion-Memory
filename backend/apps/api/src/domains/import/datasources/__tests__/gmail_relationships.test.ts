import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GmailFileImporter } from '../gmail';
import type { Graph, ImportParams } from '../timeline';

import { metaAttachments } from './support/emitted';

/**
 * Gmail participant and attachment parsing.
 *
 * The halves of the upstream `gmail_relationships` suite that need no database:
 * what the parser EMITS. That participants survive into
 * `ci_import.staged_relationships` is asserted separately, against real
 * Postgres, in `import/__tests__/gmailStaging.integration.spec.ts`.
 */

async function importMbox(file: string): Promise<Graph[]> {
  const collected: Graph[] = [];

  await new GmailFileImporter().fileImport({}, { filename: path.basename(file), fullPath: file }, {
    pipeline: { push: (graph: Graph) => collected.push(graph) },
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return collected;
}

function writeMbox(prefix: string, name: string, contents: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, name);

  fs.writeFileSync(file, contents, 'utf8');

  return { dir, file };
}

describe('Gmail attachments', () => {
  it('keeps two attachments that share a filename as distinct descriptors', () => {
    // One email, two DIFFERENT attachments that happen to be called photo.png —
    // the collision that used to drop the second one.
    const boundary = 'DUPBOUND';
    const mbox =
      `From alice@example.com Fri Jan 03 12:00:00 2025\n` +
      `Subject: Two same-name attachments\n` +
      `Date: Fri, 03 Jan 2025 12:00:00 +0000\n` +
      `From: Alice <alice@example.com>\n` +
      `Message-ID: <dup1@example.com>\n` +
      `Content-Type: multipart/mixed; boundary="${boundary}"\n\n` +
      `--${boundary}\nContent-Type: text/plain\n\nbody\n` +
      `--${boundary}\nContent-Type: image/png; name="photo.png"\n` +
      `Content-Transfer-Encoding: base64\n` +
      `Content-Disposition: attachment; filename="photo.png"\n\n` +
      `${Buffer.from('AAAA').toString('base64')}\n` +
      `--${boundary}\nContent-Type: image/png; name="photo.png"\n` +
      `Content-Transfer-Encoding: base64\n` +
      `Content-Disposition: attachment; filename="photo.png"\n\n` +
      `${Buffer.from('BBBB').toString('base64')}\n` +
      `--${boundary}--\n`;

    const { dir, file } = writeMbox('gmail-dup-', 'dup.mbox', mbox);

    return importMbox(file)
      .then((graphs) => {
        const message = graphs.find((graph) => graph.item);
        const attachments = metaAttachments(message!.item!.metadata!.MediaAttachments);

        expect(attachments).toHaveLength(2);
        // Extraction is content-addressed, so same-name different-bytes
        // attachments land in distinct files rather than overwriting.
        expect(new Set(attachments.map((attachment) => attachment.path)).size).toBe(2);
      })
      .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  });
});

describe('Gmail address-header parsing', () => {
  it('does not hang on a pathological address header', async () => {
    // A 300k-char run with no '<...>'. The old parseEmailAddress regex
    // /^(?:"?([^"<]+)"?\s*)?<([^>]+)>$/ backtracked quadratically — 120k chars
    // took 8.5s — and one such header CPU-spun an entire mbox import to a halt.
    const huge = 'x'.repeat(300_000);
    const mbox =
      `From alice@example.com Fri Jan 03 12:00:00 2025\n` +
      `Subject: Pathological header\n` +
      `Date: Fri, 03 Jan 2025 12:00:00 +0000\n` +
      `From: Alice <alice@example.com>\n` +
      `To: ${huge}\n` +
      `Message-ID: <evil1@example.com>\n\n` +
      `body\n`;

    const { dir, file } = writeMbox('gmail-evil-', 'evil.mbox', mbox);
    const previous = process.env.CI_GMAIL_INCLUDE_BULK;

    // Ensure the message reaches participant parsing at all.
    process.env.CI_GMAIL_INCLUDE_BULK = '1';

    try {
      const started = Date.now();
      const graphs = await importMbox(file);

      // Linear: milliseconds, not minutes.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(graphs.some((graph) => graph.item)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.CI_GMAIL_INCLUDE_BULK;
      } else {
        process.env.CI_GMAIL_INCLUDE_BULK = previous;
      }

      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a quoted "Last, First" name whole instead of minting a person per half', async () => {
    const mbox =
      `From ottilie@example.org Fri Oct 16 20:27:19 2026\n` +
      `Subject: Lichen results\n` +
      `Date: Fri, 16 Oct 2026 20:27:19 +0000\n` +
      `From: "Brightwater, Ottilie" <ottilie.brightwater@example.org>\n` +
      `To: Zephyrine Quillfeather <z.q@example.org>\n` +
      `Cc: "Ashcombe, Peregrine" <p.a@example.org>, =?UTF-8?Q?M=C3=BCller=2C_Hans?= <h.m@example.de>\n` +
      `Message-ID: <lichen1@example.org>\n\n` +
      `body\n`;

    const { dir, file } = writeMbox('gmail-lastfirst-', 'lastfirst.mbox', mbox);
    const previous = process.env.CI_GMAIL_INCLUDE_BULK;
    process.env.CI_GMAIL_INCLUDE_BULK = '1';

    try {
      const graphs = await importMbox(file);
      const edges = graphs.find((graph) => graph.item)?.edges ?? [];

      expect(
        edges
          .filter((edge) => ['from', 'to', 'cc'].includes(edge.relation ?? ''))
          .map((edge) => [edge.relation, edge.to?.entity?.name, edge.to?.entity?.attributes?.[0]?.value]),
      ).toEqual([
        ['from', 'Brightwater, Ottilie', 'ottilie.brightwater@example.org'],
        ['to', 'Zephyrine Quillfeather', 'z.q@example.org'],
        ['cc', 'Ashcombe, Peregrine', 'p.a@example.org'],
        ['cc', 'Müller, Hans', 'h.m@example.de'],
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.CI_GMAIL_INCLUDE_BULK;
      } else {
        process.env.CI_GMAIL_INCLUDE_BULK = previous;
      }

      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
