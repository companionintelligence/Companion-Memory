import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { SmsBackupRestoreFileImporter } from '../sms_backup_restore';
import type { ImportParams, Timeframe } from '../timeline';
import { mimeForFile } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const EXPORT_DIR = path.join(FIXTURES_DIR, 'sms-backup-restore-export');
const XML_FILE = path.join(EXPORT_DIR, 'sms.xml');

function runImport(entry: { filename: string; fullPath: string }) {
  const pipeline: EmittedGraph[] = [];
  const fi = new SmsBackupRestoreFileImporter();

  return fi
    .fileImport({}, entry, { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams)
    .then(() => pipeline);
}

function runImportWithTimeframe(entry: { filename: string; fullPath: string }, timeframe: Timeframe) {
  const pipeline: EmittedGraph[] = [];
  const fi = new SmsBackupRestoreFileImporter();

  return fi
    .fileImport({}, entry, { pipeline, timeframe, log: () => {} } as unknown as ImportParams)
    .then(() => pipeline);
}

describe('SMS Backup & Restore datasource', () => {
  it('recognizes a directory containing the smses XML', async () => {
    const fi = new SmsBackupRestoreFileImporter();
    const rec = await fi.recognize({}, { filename: 'sms-backup-restore-export', fullPath: EXPORT_DIR });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a single sms.xml file', async () => {
    const fi = new SmsBackupRestoreFileImporter();
    const rec = await fi.recognize({}, { filename: 'sms.xml', fullPath: XML_FILE });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('does not recognize a plain non-smses xml file', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-plain-${Date.now()}.xml`);
    fs.writeFileSync(tmp, '<?xml version="1.0"?><root><node/></root>');
    try {
      const fi = new SmsBackupRestoreFileImporter();
      const rec = await fi.recognize({}, { filename: 'plain.xml', fullPath: tmp });
      expect(rec.confidence).toBe(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('imports SMS messages as message items', async () => {
    const pipeline = await runImport({ filename: 'sms.xml', fullPath: XML_FILE });
    expect(pipeline.length).toBe(2);
    expect(pipeline.every((p) => p.item.classification === 'message')).toBe(true);
  });

  it('imports via the export directory too', async () => {
    const pipeline = await runImport({ filename: 'sms-backup-restore-export', fullPath: EXPORT_DIR });
    expect(pipeline.length).toBe(2);
  });

  it('parses sender and direction correctly', async () => {
    const pipeline = await runImport({ filename: 'sms.xml', fullPath: XML_FILE });
    // First message: received → sender is the contact name; no To (peer is the sender).
    expect(pipeline[0].item.metadata.Direction).toBe('received');
    expect(pipeline[0].item.metadata.Sender).toBe('Alice Example');
    expect(pipeline[0].item.metadata.To).toBeUndefined();
    expect(pipeline[0].item.metadata.Source).toBe('SMS Backup & Restore');
    expect(pipeline[0].item.timestamp).toBeDefined();
    // Second message: sent → sender is 'Me', To carries the recipient address so it people-links.
    expect(pipeline[1].item.metadata.Direction).toBe('sent');
    expect(pipeline[1].item.metadata.Sender).toBe('Me');
    expect(pipeline[1].item.metadata.To).toBe('Alice Example');
  });

  it('HTML-unescapes the message body', async () => {
    const pipeline = await runImport({ filename: 'sms.xml', fullPath: XML_FILE });
    const body = (await pipeline[1].item.content!.data!()).toString();
    expect(body).toBe('Yes! See you at 1pm & bring the docs.');
  });

  it('malformed input does not throw', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-malformed-${Date.now()}.xml`);
    // Garbage with a stray <smses and a truncated <sms tag plus binary noise.
    fs.writeFileSync(tmp, '<smses><sms date="notanumber" body="x" \x00\xff garbage <sms ');
    try {
      const pipeline = await runImport({ filename: 'malformed.xml', fullPath: tmp });
      expect(Array.isArray(pipeline)).toBe(true);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('empty input yields no items', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-empty-${Date.now()}.xml`);
    fs.writeFileSync(tmp, '');
    try {
      const pipeline = await runImport({ filename: 'empty.xml', fullPath: tmp });
      expect(pipeline.length).toBe(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('imports calls alongside messages when timeframe is not restrictive', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-with-calls-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<smses count="2" backup_set="abc-123" backup_date="1609502400000">
  <sms protocol="0" address="+15551234567" date="1609502400000" type="1" subject="null" body="Hey, are we still on for lunch?" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="1609502399000" sub_id="1" readable_date="Jan 1, 2021 12:00:00 PM" contact_name="Alice Example" />
  <sms protocol="0" address="+15551234567" date="1609506000000" type="2" subject="null" body="Yes! See you at 1pm &amp; bring the docs." toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="1609505999000" sub_id="1" readable_date="Jan 1, 2021 1:00:00 PM" contact_name="Alice Example" />
  <call date="1609509600000" type="1" duration="60" number="+15551234567" contact_name="Bob Smith" />
  <call date="1609513200000" type="2" duration="30" number="+15551234567" contact_name="Charlie Brown" />
</smses>`,
    );
    try {
      const pipeline = await runImport({ filename: 'with-calls.xml', fullPath: tmp });
      // Should have 4 items: 2 SMS messages + 2 calls
      expect(pipeline.length).toBe(4);
      // Check that we have both message and call classifications
      const classifications = pipeline.map((p) => p.item.classification);
      expect(classifications).toContain('message');
      expect(classifications).toContain('call');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('respects timeframe filtering for calls', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-timeframe-calls-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<smses count="2" backup_set="abc-123" backup_date="1609502400000">
  <sms protocol="0" address="+15551234567" date="1609502400000" type="1" subject="null" body="Hey, are we still on for lunch?" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="1609502399000" sub_id="1" readable_date="Jan 1, 2021 12:00:00 PM" contact_name="Alice Example" />
  <sms protocol="0" address="+15551234567" date="1609506000000" type="2" subject="null" body="Yes! See you at 1pm &amp; bring the docs." toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="1609505999000" sub_id="1" readable_date="Jan 1, 2021 1:00:00 PM" contact_name="Alice Example" />
  <call date="1609509600000" type="1" duration="60" number="+15551234567" contact_name="Bob Smith" />
  <call date="1609513200000" type="2" duration="30" number="+15551234567" contact_name="Charlie Brown" />
</smses>`,
    );
    try {
      // Set a timeframe that only includes the first SMS, not the calls
      const timeframe = { since: new Date(1609502500000), until: new Date(1609506100000) };
      const pipeline = await runImportWithTimeframe(
        { filename: 'timeframe-calls.xml', fullPath: tmp },
        timeframe,
      );
      // Should only have 1 item (the first SMS) since calls are outside timeframe
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.classification).toBe('message');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('imports MMS messages with text content', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-mms-text-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <mms date="1609502400000" msg_box="1" address="+15551234567" contact_name="Alice Example">
    <parts>
      <part ct="text/plain" chset="utf-8" text="Hello from MMS!" />
    </parts>
    <addrs>
      <addr type="137" address="+15551234567" charset="utf-8" />
    </addrs>
  </mms>
  <mms date="1609506000000" msg_box="2" address="+15551234567" contact_name="Alice Example">
    <parts>
      <part ct="text/plain" chset="utf-8" text="Replying via MMS" />
    </parts>
    <addrs>
      <addr type="151" address="+15551234567" charset="utf-8" />
    </addrs>
  </mms>
</smses>`,
    );
    try {
      const pipeline = await runImport({ filename: 'mms-text.xml', fullPath: tmp });
      expect(pipeline.length).toBe(2);
      // First MMS: received
      expect(pipeline[0].item.classification).toBe('message');
      expect(pipeline[0].item.metadata.Direction).toBe('inbound');
      expect(pipeline[0].item.metadata.Sender).toBe('+15551234567');
      expect(pipeline[0].item.metadata.To).toBeUndefined();
      const text1 = await pipeline[0].item.content!.data!();
      expect(text1.toString()).toBe('Hello from MMS!');
      // Second MMS: sent
      expect(pipeline[1].item.classification).toBe('message');
      expect(pipeline[1].item.metadata.Direction).toBe('outbound');
      expect(pipeline[1].item.metadata.Sender).toBe('Me');
      expect(Array.isArray(pipeline[1].item.metadata.To)).toBe(true);
      const text2 = await pipeline[1].item.content!.data!();
      expect(text2.toString()).toBe('Replying via MMS');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('takes a group MMS sender from its From addr and the other members as recipients', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-mms-group-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <mms date="1786284333000" msg_box="1" address="+12065550182~+12065550133" contact_name="Leopold Ashgrove, (Unknown)">
    <parts>
      <part seq="0" ct="text/plain" chset="106" text="group photo from the regatta" />
    </parts>
    <addrs>
      <addr address="+12065550182" type="137" charset="106" />
      <addr address="+12065550133" type="151" charset="106" />
      <addr address="+12065550147" type="151" charset="106" />
    </addrs>
  </mms>
  <mms date="1786284400000" msg_box="2" address="+12065550182~+12065550133" contact_name="Leopold Ashgrove, (Unknown)">
    <parts>
      <part seq="0" ct="text/plain" chset="106" text="see you there" />
    </parts>
    <addrs>
      <addr address="insert-address-token" type="137" charset="106" />
      <addr address="+12065550182" type="151" charset="106" />
      <addr address="+12065550133" type="130" charset="106" />
    </addrs>
  </mms>
  <mms date="1786284500000" msg_box="1" address="+12065550182~+12065550133">
    <parts>
      <part seq="0" ct="text/plain" chset="106" text="an older backup with no addrs" />
    </parts>
  </mms>
</smses>`,
    );
    try {
      const pipeline = await runImport({ filename: 'mms-group.xml', fullPath: tmp });
      expect(pipeline.map((p) => [p.item.metadata.Sender, p.item.metadata.To])).toEqual([
        // You (+12065550147) are not on the root list, so not a recipient, as on a received SMS.
        ['+12065550182', ['+12065550133']],
        ['Me', ['+12065550182', '+12065550133']],
        // No addrs: the sender can't be told apart, but the joined string is not a sender.
        [undefined, ['+12065550182', '+12065550133']],
      ]);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('imports MMS with fallback content when no text part', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-mms-nofallback-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <mms date="1609502400000" msg_box="1" address="+15551234567" contact_name="Alice Example">
    <parts>
      <part ct="image/jpeg" name="photo.jpg" data="" />
    </parts>
    <addrs>
      <addr type="137" address="+15551234567" charset="utf-8" />
    </addrs>
  </mms>
</smses>`,
    );
    try {
      const pipeline = await runImport({ filename: 'mms-nofallback.xml', fullPath: tmp });
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.classification).toBe('message');
      expect(pipeline[0].item.metadata.Direction).toBe('inbound');
      const text = await pipeline[0].item.content!.data!();
      expect(text.toString()).toBe('Received MMS from +15551234567');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('ignores MMS with msg_box other than 1 or 2', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-mms-ignore-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <mms date="1609502400000" msg_box="3" address="+15551234567">
    <parts>
      <part ct="text/plain" text="should be ignored" />
    </parts>
    <addrs>
      <addr type="137" address="+15551234567" />
    </addrs>
  </mms>
</smses>`,
    );
    try {
      const pipeline = await runImport({ filename: 'mms-ignore.xml', fullPath: tmp });
      expect(pipeline.length).toBe(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('handles MMS charset decoding', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-mms-charset-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <mms date="1609502400000" msg_box="1" address="+15551234567">
    <parts>
      <part ct="text/plain" chset="1252" text="Latin-1 text: caf\u00e9" />
    </parts>
    <addrs>
      <addr type="137" address="+15551234567" charset="1252" />
    </addrs>
  </mms>
</smses>`,
    );
    try {
      const pipeline = await runImport({ filename: 'mms-charset.xml', fullPath: tmp });
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.metadata.Direction).toBe('inbound');
      const text = await pipeline[0].item.content!.data!();
      expect(text.toString()).toBe('Latin-1 text: caf\u00e9');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  // Collect every MMS media temp path a pipeline produced, so a test can clean up.
  function mediaPathsOf(pipeline: EmittedGraph[]): string[] {
    return pipeline.flatMap((p) => (p.item.metadata.MediaFilePaths as string[] | undefined) ?? []);
  }

  // Build an MMS XML whose single media <part> carries `payload` as inline base64.
  // A trailing `coupon_data="null"` sits right before `data=` to prove the parser
  // anchors on the ` data="` attribute boundary and is not fooled by *_data attrs.
  function mmsWithMedia(payload: Buffer, ct: string, name: string): string {
    return `<?xml version='1.0' encoding='UTF-8'?>
<smses count="1">
  <mms date="1600000000000" msg_box="1" address="+15551230000" contact_name="Big Sender" m_id="MID1" thread_id="9">
    <parts>
      <part seq="0" ct="text/plain" chset="utf-8" text="see attachment" />
      <part seq="0" ct="${ct}" name="${name}" cid="&lt;a&gt;" coupon_data="null" data="${payload.toString('base64')}" />
    </parts>
    <addrs><addr address="+15551230000" type="137" charset="106" /></addrs>
  </mms>
</smses>`;
  }

  it('streams MMS media to a temp file on disk, byte-for-byte', async () => {
    const payload = randomBytes(200_000); // spans the 256KB read chunk logic without being huge
    const sha = createHash('sha256').update(payload).digest('hex');
    const tmp = path.join(os.tmpdir(), `sbr-mms-media-${Date.now()}.xml`);
    fs.writeFileSync(tmp, mmsWithMedia(payload, 'image/jpeg', 'photo.jpg'));
    const pipeline = await runImport({ filename: 'mms-media.xml', fullPath: tmp });
    try {
      expect(pipeline.length).toBe(1);
      const meta = pipeline[0].item.metadata;
      expect(meta.Text).toBe('see attachment');
      expect(Array.isArray(meta.MediaFilePaths)).toBe(true);
      const mediaPaths = meta.MediaFilePaths as string[];
      expect(mediaPaths.length).toBe(1);
      const mp = mediaPaths[0];
      // Extension is preserved so the MIME can be re-derived downstream.
      expect(path.extname(mp)).toBe('.jpg');
      expect(fs.existsSync(mp)).toBe(true);
      const got = createHash('sha256').update(fs.readFileSync(mp)).digest('hex');
      expect(got).toBe(sha);
    } finally {
      mediaPathsOf(pipeline).forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      });
      fs.unlinkSync(tmp);
    }
  });

  it('imports non-image attachments too (any multimedia file)', async () => {
    const payload = randomBytes(5_000);
    const tmp = path.join(os.tmpdir(), `sbr-mms-audio-${Date.now()}.xml`);
    fs.writeFileSync(tmp, mmsWithMedia(payload, 'audio/amr', 'clip.amr'));
    const pipeline = await runImport({ filename: 'mms-audio.xml', fullPath: tmp });
    try {
      const mps = mediaPathsOf(pipeline);
      expect(mps.length).toBe(1);
      expect(path.extname(mps[0])).toBe('.amr');
      expect(fs.readFileSync(mps[0]).length).toBe(payload.length);
    } finally {
      mediaPathsOf(pipeline).forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      });
      fs.unlinkSync(tmp);
    }
  });

  // Plenty of MMS parts carry no usable name (`name="null"` is what the app
  // writes), so the temp file's extension has to come from the part's content
  // type — and that extension is the ONLY thing mimeForFile has to work from
  // later. These pin the round trip, and above all that it never lands on an
  // extension of the wrong media class.
  it('derives a media extension from the content type when the part has no name', async () => {
    const cases = [
      { ct: 'image/jpeg', ext: '.jpg', mime: 'image/jpeg' },
      { ct: 'video/3gpp', ext: '.3gp', mime: 'video/3gpp' },
      { ct: 'application/pdf', ext: '.pdf', mime: 'application/pdf' },
      // mime-db's first extension for audio/mpeg is .mpga — correct, but not what
      // anyone calls an MP3.
      { ct: 'audio/mpeg', ext: '.mp3', mime: 'audio/mpeg' },
      // Android senders emit these non-standard types; no registry lists them, so
      // the sanitized-subtype fallback carries them.
      { ct: 'image/jpg', ext: '.jpg', mime: 'image/jpeg' },
      { ct: 'video/avi', ext: '.avi', mime: 'video/x-msvideo' },
    ];
    const parts = cases
      .map(
        (c, i) => `<part seq="${i}" ct="${c.ct}" name="null" data="${randomBytes(16).toString('base64')}" />`,
      )
      .join('\n    ');
    const tmp = path.join(os.tmpdir(), `sbr-mms-ct-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version='1.0'?>
<smses><mms date="1600000000000" msg_box="2" address="+15551230000">
  <parts>
    ${parts}
  </parts>
</mms></smses>`,
    );
    const pipeline = await runImport({ filename: 'mms-ct.xml', fullPath: tmp });
    try {
      const mps = mediaPathsOf(pipeline);
      expect(mps.length).toBe(cases.length);
      cases.forEach((c, i) => {
        expect(path.extname(mps[i])).toBe(c.ext);
        expect(mimeForFile(mps[i])).toBe(c.mime);
      });
    } finally {
      mediaPathsOf(pipeline).forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      });
      fs.unlinkSync(tmp);
    }
  });

  it('never types an audio attachment as video (.3gpp would)', async () => {
    // mime-db lists .3gpp first for audio/3gpp, but .3gpp reads BACK as
    // video/3gpp — taking it would import a voice clip as a video.
    const tmp = path.join(os.tmpdir(), `sbr-mms-3ga-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version='1.0'?>
<smses><mms date="1600000000000" msg_box="2" address="+15551230000">
  <parts><part seq="0" ct="audio/3gpp" name="null" data="${randomBytes(16).toString('base64')}" /></parts>
</mms></smses>`,
    );
    const pipeline = await runImport({ filename: 'mms-3ga.xml', fullPath: tmp });
    try {
      const mps = mediaPathsOf(pipeline);
      expect(path.extname(mps[0])).toBe('.3ga');
      expect(mimeForFile(mps[0]) ?? '').not.toMatch(/^video\//);
    } finally {
      mediaPathsOf(pipeline).forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      });
      fs.unlinkSync(tmp);
    }
  });

  it('handles multiple media parts in one MMS', async () => {
    const a = randomBytes(1024),
      b = randomBytes(2048);
    const tmp = path.join(os.tmpdir(), `sbr-mms-multi-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version='1.0'?>
<smses><mms date="1600000000000" msg_box="2" address="+15551230000">
  <parts>
    <part seq="0" ct="image/png" name="one.png" data="${a.toString('base64')}" />
    <part seq="0" ct="video/mp4" name="two.mp4" data="${b.toString('base64')}" />
  </parts>
</mms></smses>`,
    );
    const pipeline = await runImport({ filename: 'mms-multi.xml', fullPath: tmp });
    try {
      const mps = mediaPathsOf(pipeline);
      expect(mps.length).toBe(2);
      expect(fs.readFileSync(mps[0]).length).toBe(a.length);
      expect(fs.readFileSync(mps[1]).length).toBe(b.length);
      // No text part \u2192 synthesized fallback content.
      expect((await pipeline[0].item.content!.data!()).toString()).toBe('Sent MMS to +15551230000');
    } finally {
      mediaPathsOf(pipeline).forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      });
      fs.unlinkSync(tmp);
    }
  });

  it('writes attachments into mediaStoreDir when one is provided', async () => {
    const payload = randomBytes(3000);
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'sbr-store-'));
    const tmp = path.join(os.tmpdir(), `sbr-mms-store-${Date.now()}.xml`);
    fs.writeFileSync(tmp, mmsWithMedia(payload, 'image/jpeg', 'photo.jpg'));
    const pipeline: EmittedGraph[] = [];
    const fi = new SmsBackupRestoreFileImporter();
    await fi.fileImport({}, { filename: 'mms.xml', fullPath: tmp }, {
      pipeline,
      timeframe: {},
      mediaStoreDir: store,
      log: () => {},
    } as unknown as ImportParams);
    try {
      const mps = mediaPathsOf(pipeline);
      expect(mps.length).toBe(1);
      // The attachment lives under the store dir, so the push can purge it later.
      expect(path.dirname(mps[0])).toBe(store);
      expect(fs.readFileSync(mps[0]).length).toBe(payload.length);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
      fs.unlinkSync(tmp);
    }
  });

  it('writes no media file for an empty data attribute', async () => {
    const tmp = path.join(os.tmpdir(), `sbr-mms-emptydata-${Date.now()}.xml`);
    fs.writeFileSync(
      tmp,
      `<?xml version='1.0'?>
<smses><mms date="1600000000000" msg_box="1" address="+15551230000">
  <parts><part seq="0" ct="image/jpeg" name="photo.jpg" data="" /></parts>
</mms></smses>`,
    );
    const pipeline = await runImport({ filename: 'mms-emptydata.xml', fullPath: tmp });
    try {
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.metadata.MediaFilePaths).toBeUndefined();
    } finally {
      mediaPathsOf(pipeline).forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      });
      fs.unlinkSync(tmp);
    }
  });

  it('does not leave media temp files for a filtered-out MMS', async () => {
    const payload = randomBytes(4096);
    const tmp = path.join(os.tmpdir(), `sbr-mms-filtered-${Date.now()}.xml`);
    // msg_box=3 (draft) is discarded \u2014 its attachment must never touch disk.
    fs.writeFileSync(
      tmp,
      mmsWithMedia(payload, 'image/jpeg', 'photo.jpg').replace('msg_box="1"', 'msg_box="3"'),
    );
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('mms-media-')));
    const pipeline = await runImport({ filename: 'mms-filtered.xml', fullPath: tmp });
    try {
      expect(pipeline.length).toBe(0);
      const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('mms-media-') && !before.has(f));
      expect(after).toEqual([]);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
