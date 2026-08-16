import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import type { EntityAttribute, ImportParams } from '../timeline';
import { VCardFileImporter } from '../vcard';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/**
 * A contact is emitted as an ITEM carrying a `contact` edge to its entity, not
 * as a bare entity. That is the shape the upstream rewrite settled on and it is
 * load-bearing: the item is what gives a card a stable id to dedup a re-import
 * against, and the edge is what lets a contact resolve to a person. The old
 * entity-only emission is precisely what made 5,250 contacts import as zero
 * items.
 */
function contactEntities(emitted: EmittedGraph[]) {
  return emitted.flatMap((graph) =>
    (graph.edges ?? [])
      .filter((edge) => edge.relation === 'contact')
      .map((edge) => edge.to?.entity)
      .filter(Boolean),
  );
}

describe('vCard datasource', () => {
  it('recognizes .vcf file', async () => {
    const vcfPath = path.join(FIXTURES_DIR, 'sample.vcf');
    const fi = new VCardFileImporter();
    const rec = await fi.recognize({}, { filename: 'sample.vcf', fullPath: vcfPath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports vCard contacts', async () => {
    const vcfPath = path.join(FIXTURES_DIR, 'sample.vcf');
    const fi = new VCardFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'sample.vcf', fullPath: vcfPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const entities = contactEntities(pipeline);
    expect(entities.length).toBe(2);
    expect(entities[0]!.name).toBe('John Doe');
    expect(entities[0]!.metadata?.Source).toBe('vCard');
    expect(entities[0]!.attributes).toBeDefined();

    // Every card is now an item too — the half that was missing before.
    expect(pipeline.filter((p) => p.item).length).toBe(2);
  });

  it('unescapes RFC 6350 TEXT backslash sequences in NOTE (and other TEXT fields)', async () => {
    // Real Apple Contacts export: 2271/2285 (99.4%) of NOTE attributes
    // carried literal \, / \; / \n sequences that were never decoded to
    // real punctuation/newlines before being stored.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vcf-unescape-'));
    const vcfPath = path.join(dir, 'escaped.vcf');
    fs.writeFileSync(
      vcfPath,
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Jane\\, Q. Public',
        'N:Public;Jane;Q.;;',
        'TEL;TYPE=HOME:+1-555-123-4567',
        'EMAIL;TYPE=INTERNET:jane@example.com',
        'NICKNAME:J.Q.\\; The Second',
        'NOTE:Met at conf\\, Chicago\\; follow up\\nSent contract\\\\draft',
        'END:VCARD',
      ].join('\r\n'),
    );
    try {
      const fi = new VCardFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'escaped.vcf', fullPath: vcfPath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      const [entity] = contactEntities(pipeline);
      expect(entity!.name).toBe('Jane, Q. Public');
      const nickname = entity!.attributes!.find((a: EntityAttribute) => a.name === 'nickname');
      expect(nickname!.value).toBe('J.Q.; The Second');
      const note = entity!.attributes!.find((a: EntityAttribute) => a.name === 'note');
      expect(note!.value).toBe('Met at conf, Chicago; follow up\nSent contract\\draft');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
