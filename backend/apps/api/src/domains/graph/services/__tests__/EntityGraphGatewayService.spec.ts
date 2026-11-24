import {
  computeEntityAliasSimilarity,
  EntityGraphGatewayService,
  normalizeEntityKey,
  normalizeEntityName,
} from '../EntityGraphGatewayService';

describe('EntityGraphGatewayService', () => {
  const gateway = new EntityGraphGatewayService();

  it('normalizes Person honorifics/middle initials and Organization corporate suffixes consistently', () => {
    expect(normalizeEntityName('Dr. Jane M. Doe', 'Person')).toBe('jane doe');
    expect(normalizeEntityKey('Prof. Jane Doe', 'Person')).toBe('person::jane doe');
    expect(normalizeEntityName('Acme Robotics, Inc.', 'Organization')).toBe('acme robotics');
    expect(normalizeEntityKey('Acme Robotics Corp.', 'Organization')).toBe('organization::acme robotics');
  });

  it('computes high alias similarity for honorifics, corporate suffixes, and prefix variations', () => {
    expect(computeEntityAliasSimilarity('Dr. Jane Doe', 'Jane M. Doe', 'Person')).toBe(1);
    expect(computeEntityAliasSimilarity('Acme Labs', 'Acme Labs Inc.', 'Organization')).toBe(1);
    expect(computeEntityAliasSimilarity('Alice Smith', 'Bob Jones', 'Person')).toBe(0);
  });

  it('reconciles intra-batch duplicates and merges against existing graph entities with provenance', () => {
    const reconciled = gateway.reconcileCandidateBatch(
      [
        {
          name: 'Dr. Jane Doe',
          entityType: 'Person',
          confidence: 0.75,
          sourceWriter: 'compaction',
          sourceRecordId: 'turn-1',
          extractedAt: '2026-10-20T00:00:00.000Z',
        },
        {
          name: 'Jane M. Doe',
          entityType: 'Person',
          description: 'Principal neuroscientist',
          confidence: 0.92,
          sourceWriter: 'concept_extraction',
          sourceRecordId: 'note-2',
          extractedAt: '2026-10-20T00:01:00.000Z',
        },
        {
          name: 'Companion Labs, Inc.',
          entityType: 'Organization',
          confidence: 0.88,
          sourceWriter: 'graph_ingest',
          sourceRecordId: 'doc-3',
          extractedAt: '2026-10-20T00:02:00.000Z',
        },
      ],
      [
        {
          id: 'org-existing-1',
          name: 'Companion Labs',
          entityType: 'Organization',
          aliases: ['Companion AI'],
          confidence: 0.8,
        },
      ],
    );

    expect(reconciled).toHaveLength(2);

    const person = reconciled.find((r) => r.entityType === 'Person')!;
    expect(person.action).toBe('create');
    expect(person.canonicalName).toBe('Dr. Jane Doe');
    expect(person.aliases).toContain('Jane M. Doe');
    expect(person.confidence).toBe(0.92);
    expect(person.description).toBe('Principal neuroscientist');
    expect(person.provenance).toHaveLength(2);

    const org = reconciled.find((r) => r.entityType === 'Organization')!;
    expect(org.action).toBe('merge');
    expect(org.matchedEntityId).toBe('org-existing-1');
    expect(org.canonicalName).toBe('Companion Labs');
    expect(org.aliases).toEqual(['Companion AI', 'Companion Labs, Inc.']);
    expect(org.confidence).toBe(0.88);
  });
});
