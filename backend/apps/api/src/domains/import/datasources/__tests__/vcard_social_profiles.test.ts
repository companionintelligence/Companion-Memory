/*
 * X-SOCIALPROFILE: a folded line must unfold whole, and a line the EXPORTER cut
 * short must not be stored as a profile.
 *
 * A real Contacts export stored 552 LinkedIn profiles as `https://www.lin`,
 * `https://www.linked`, `https://www.`: the physical line stops (at 74 bytes)
 * and the next line is the card's NOTE, not a continuation. An `x-displayname`
 * parameter of varying length ahead of the value moves the cut on every card.
 * See resolveSocialProfile in ../vcard.ts.
 *
 * Every name, slug and URL here is invented.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Entity, EntityAttribute, ImportParams, Metadata } from '../timeline';
import { VCardFileImporter } from '../vcard';

import type { EmittedGraph } from './support/emitted';

const SLUG = 'quinn-example-invented';
const PROFILE = `https://www.linkedin.com/in/${SLUG}`;

/** Run one card through the real importer: read, unfold, tokenize, build. */
async function importCard(lines: string[], eol = '\r\n') {
  const raw = ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD', ''].join(eol);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vcf-social-'));
  const fpath = path.join(dir, 'card.vcf');
  fs.writeFileSync(fpath, raw);

  const pipeline: EmittedGraph[] = [];
  const drops: Record<string, number> = {};
  const params = {
    pipeline: {
      push: (g: EmittedGraph) => pipeline.push(g),
      drop: (reason: string) => {
        drops[reason] = (drops[reason] ?? 0) + 1;
      },
    },
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams;

  try {
    await new VCardFileImporter().fileImport({}, { filename: 'card.vcf', fullPath: fpath }, params);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const entities = pipeline.flatMap((g) =>
    (g.edges ?? []).map((e) => e.to?.entity).filter(Boolean),
  ) as Entity[];
  expect(entities).toHaveLength(1);
  const [entity] = entities;
  const metadata = entity.metadata as Metadata;

  return {
    drops,
    socialProfiles: metadata.SocialProfiles as string[] | undefined,
    itemSocialProfiles: pipeline[0].item.metadata.SocialProfiles as string[] | undefined,
    socialAttributes: (entity.attributes ?? []).filter(
      (a) => a.name === 'social_profile',
    ) as (EntityAttribute & {
      label?: string;
    })[],
  };
}

/** RFC 6350 §3.2 fold: CRLF + one SPACE (or TAB) inserted before `at`. */
function foldAt(line: string, at: number, ws = ' '): string {
  return `${line.slice(0, at)}\r\n${ws}${line.slice(at)}`;
}

/** What the exporter did: stop the line at `bytes` octets and write nothing more of it. */
function cutAt(line: string, bytes: number): string {
  return Buffer.from(line, 'utf8').subarray(0, bytes).toString('utf8');
}

describe('X-SOCIALPROFILE across an RFC 6350 fold', () => {
  const APPLE_LINE = `item2.X-SOCIALPROFILE;type=linkedin;x-user=${SLUG}:https\\://www.linkedin.com/in/${SLUG}`;

  it('unfolds an Apple-style grouped, `\\:`-escaped line folded at 75 octets', async () => {
    const folded = foldAt(APPLE_LINE, 75);
    // Not vacuous: the first physical line really does stop inside the URL.
    expect(folded.split('\r\n')[0]).toHaveLength(75);
    expect(folded.split('\r\n')[0]).not.toContain('linkedin.com');

    const { socialProfiles, itemSocialProfiles, socialAttributes } = await importCard([
      'FN:Quinn Example',
      folded,
    ]);

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
    expect(itemSocialProfiles).toEqual([`linkedin: ${PROFILE}`]);
    expect(socialAttributes).toEqual([{ name: 'social_profile', value: PROFILE, label: 'linkedin' }]);
  });

  it.each([
    ['between the `\\` and the `:` of the escape', APPLE_LINE.indexOf('\\:') + 1, ' '],
    ['inside the x-user parameter', APPLE_LINE.indexOf('x-user=') + 10, ' '],
    ['inside the group prefix', 3, ' '],
    ['inside the slug', APPLE_LINE.length - 5, ' '],
    ['with a TAB continuation', 75, '\t'],
  ])('unfolds a fold %s', async (_where, at, ws) => {
    const { socialProfiles } = await importCard(['FN:Quinn Example', foldAt(APPLE_LINE, at, ws)]);

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
  });

  it('unfolds across more than one fold, with LF-only line endings', async () => {
    const twice = foldAt(foldAt(APPLE_LINE, 75), 40);
    const { socialProfiles } = await importCard(['FN:Quinn Example', ...twice.split('\r\n')], '\n');

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
  });

  it("labels the profile with the group's X-ABLabel when the export attached one", async () => {
    const { socialProfiles } = await importCard([
      'FN:Quinn Example',
      foldAt(APPLE_LINE, 75),
      'item2.X-ABLabel:LinkedIn',
    ]);

    expect(socialProfiles).toEqual([`LinkedIn: ${PROFILE}`]);
  });
});

describe('X-SOCIALPROFILE truncated by the exporter (no continuation line)', () => {
  /** The line as it should have been written. */
  const fullLine = (displayName: string) =>
    `X-SOCIALPROFILE;type=linkedin;x-displayname=${displayName}:${PROFILE}`;
  /** The LinkedIn sync's record of the same connection, as the card's NOTE. */
  const NOTE = `NOTE:URL\\: https\\://www.linkedin.com/in/${SLUG}\\nPosition\\: Invented Role\\nConnected On\\: 01 Jan 2020\\n`;

  // Display names of different lengths move a 74-byte cut to different points
  // in the value, exactly as in the real export.
  it.each([
    ['QUINN EXAMPLES', 'https://www.lin'],
    ['QUINN EXAMP', 'https://www.linked'],
    ['QUINN R. EXAMPLES', 'https://www.'],
    ['Q', 'https://www.linkedin.com/in/'],
    ['QUINN ROBIN EXAMPLE-IN', 'https:/'],
    ['QUINN ROBIN EXAMPLE-INVENTED', 'h'],
  ])(
    'repairs the value cut after x-displayname=%j (value %j) from the NOTE URL',
    async (displayName, expectedCut) => {
      const cut = cutAt(fullLine(displayName), 74);
      // Not vacuous: the stored line really is the broken shape.
      expect(cut.slice(cut.indexOf(':') + 1)).toBe(expectedCut);

      const { socialProfiles, socialAttributes } = await importCard(['FN:Quinn Example', cut, NOTE]);

      expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
      expect(socialAttributes.map((a) => a.value)).toEqual([PROFILE]);
    },
  );

  it('repairs a value cut inside the slug, which looks like a whole URL on its own', async () => {
    const cut = cutAt(`X-SOCIALPROFILE;type=linkedin:${PROFILE}`, 74);
    expect(cut.endsWith(`/in/${SLUG.slice(0, 16)}`)).toBe(true);

    const { socialProfiles } = await importCard(['FN:Quinn Example', cut, NOTE]);

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
  });

  it('repairs the value from a URL property on the same card', async () => {
    const { socialProfiles } = await importCard([
      'FN:Quinn Example',
      cutAt(fullLine('QUINN EXAMPLE'), 74),
      `item1.URL:${PROFILE}`,
    ]);

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
  });

  it('repairs the value from the x-user handle when the card holds no URL', async () => {
    const cut = cutAt(`X-SOCIALPROFILE;type=linkedin;x-user=${SLUG}:${PROFILE}`, 74);
    expect(cut.endsWith(':https://www.li')).toBe(true);

    const { socialProfiles } = await importCard(['FN:Quinn Example', cut]);

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
  });

  it('builds the profile from x-user when the value is missing entirely', async () => {
    const { socialProfiles } = await importCard([
      'FN:Quinn Example',
      `X-SOCIALPROFILE;type=linkedin;x-user=${SLUG}:`,
    ]);

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
  });

  it('drops a fragment it cannot repair instead of storing a broken URL, and still imports the card', async () => {
    const { drops, socialProfiles, itemSocialProfiles, socialAttributes } = await importCard([
      'FN:Quinn Example',
      cutAt(fullLine('QUINN EXAMPLE'), 74),
      'NOTE:Met at an invented conference.',
    ]);

    expect(drops).toEqual({});
    expect(socialProfiles).toBeUndefined();
    expect(itemSocialProfiles).toBeUndefined();
    expect(socialAttributes).toEqual([]);
  });

  it('never borrows a URL on another domain, even one the fragment is a prefix of', async () => {
    const { socialProfiles } = await importCard([
      'FN:Quinn Example',
      cutAt(fullLine('QUINN R. EXAMPLES'), 74), // value `https://www.`
      'URL:https://www.example.invalid/quinn',
    ]);

    expect(socialProfiles).toBeUndefined();
  });

  it('does not guess between two different profiles the fragment could be', async () => {
    const { socialProfiles } = await importCard([
      'FN:Quinn Example',
      cutAt(fullLine('QUINN EXAMPLE'), 74),
      `NOTE:URL\\: ${PROFILE.replace('://', '\\://')}\\nOther\\: https\\://www.linkedin.com/in/someone-else-invented\\n`,
    ]);

    expect(socialProfiles).toBeUndefined();
  });

  it('counts http:// and https:// spellings of one profile as one candidate', async () => {
    const { socialProfiles } = await importCard([
      'FN:Quinn Example',
      cutAt(fullLine('QUINN EXAMPLE'), 74),
      `URL:${PROFILE}`,
      `NOTE:URL\\: ${PROFILE.replace('https://', 'http\\://')}\\n`,
    ]);

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
  });
});

describe('a whole X-SOCIALPROFILE / IMPP value is kept as written', () => {
  it('does not rewrite a complete profile to a longer page on the card that merely extends it', async () => {
    const { socialProfiles } = await importCard([
      'FN:Quinn Example',
      `X-SOCIALPROFILE;type=linkedin:${PROFILE}`,
      `URL:${PROFILE}/details/experience`,
    ]);

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
  });

  it('keeps the value when x-user names a shorter handle than the URL', async () => {
    const { socialProfiles } = await importCard([
      'FN:Quinn Example',
      `X-SOCIALPROFILE;type=linkedin;x-user=quinn:${PROFILE}`,
    ]);

    expect(socialProfiles).toEqual([`linkedin: ${PROFILE}`]);
  });

  it('leaves an unknown service alone, and falls back to x-user only when its value is empty', async () => {
    const { socialProfiles } = await importCard([
      'FN:Quinn Example',
      'X-SOCIALPROFILE;type=invented-network;x-user=quinn-handle:https://www.inv',
      'X-SOCIALPROFILE;type=other-network;x-user=quinn-handle:',
      'IMPP;X-SERVICE-TYPE=Facebook:xmpp:quinn@chat.example.invalid',
    ]);

    expect(socialProfiles).toEqual([
      'invented-network: https://www.inv',
      'other-network: quinn-handle',
      'Facebook: xmpp:quinn@chat.example.invalid',
    ]);
  });
});
