import type { User } from '@ci/domains/user';

import { FOAF, PIM, RDF_TYPE, SOLID, isNamedNode, serializeJsonLd, type Quad } from '../../rdf';
import { ProfileDocumentService } from '../ProfileDocumentService';
import type { WebIdService } from '../WebIdService';

/**
 * The profile builder turns a `User` row into the public WebID graph. These
 * tests pin the graph's shape (the document describes `#me`, `#me` is a
 * foaf:Agent with a name/mailbox/storage) and the conditional issuer triple,
 * independent of URL-minting details (a stub WebIdService supplies fixed IRIs).
 */
const ORIGIN = 'https://ci.example';
const WEBID = 'https://ci.example/solid/profile/u1#me';
const DOC = 'https://ci.example/solid/profile/u1';
const STORAGE = 'https://ci.example/solid/storage/u1/';

const user: User = {
  id: 'u1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  entityId: null,
  onboarded: true,
  timezone: 'UTC',
  createdAt: new Date('2020-01-01T00:00:00Z'),
  updatedAt: new Date('2020-01-01T00:00:00Z'),
} as User;

const stubWebIds = (issuer: string): WebIdService =>
  ({
    profileDocumentUrl: () => DOC,
    webId: () => WEBID,
    storageUrl: () => STORAGE,
    oidcIssuer: () => issuer,
  }) as unknown as WebIdService;

const objectsOf = (quads: Quad[], subject: string, predicate: string): string[] =>
  quads
    .filter((q) => q.subject.value === subject && q.predicate.value === predicate)
    .map((q) => q.object.value);

describe('ProfileDocumentService.build', () => {
  it('links the document to the #me subject it describes', () => {
    const quads = new ProfileDocumentService(stubWebIds('https://portal.example')).build(user, ORIGIN);

    expect(objectsOf(quads, DOC, RDF_TYPE)).toContain(FOAF('PersonalProfileDocument'));
    expect(objectsOf(quads, DOC, FOAF('primaryTopic'))).toEqual([WEBID]);
  });

  it('describes #me as a foaf:Agent with name, mailbox, and storage', () => {
    const quads = new ProfileDocumentService(stubWebIds('https://portal.example')).build(user, ORIGIN);

    expect(objectsOf(quads, WEBID, RDF_TYPE)).toContain(FOAF('Agent'));
    expect(objectsOf(quads, WEBID, FOAF('name'))).toEqual(['Ada Lovelace']);
    expect(objectsOf(quads, WEBID, FOAF('mbox'))).toEqual(['mailto:ada@example.com']);
    expect(objectsOf(quads, WEBID, PIM('storage'))).toEqual([STORAGE]);
  });

  it('emits the mailbox as an IRI term, not a string literal', () => {
    const quads = new ProfileDocumentService(stubWebIds('')).build(user, ORIGIN);
    const mbox = quads.find((q) => q.predicate.value === FOAF('mbox'))!;
    expect(isNamedNode(mbox.object)).toBe(true);
  });

  it('includes solid:oidcIssuer only when an issuer is configured', () => {
    const withIssuer = new ProfileDocumentService(stubWebIds('https://portal.example')).build(user, ORIGIN);
    expect(objectsOf(withIssuer, WEBID, SOLID('oidcIssuer'))).toEqual(['https://portal.example']);

    const withoutIssuer = new ProfileDocumentService(stubWebIds('')).build(user, ORIGIN);
    expect(objectsOf(withoutIssuer, WEBID, SOLID('oidcIssuer'))).toEqual([]);
  });

  it('serializes to JSON-LD that round-trips the type and name', () => {
    const quads = new ProfileDocumentService(stubWebIds('https://portal.example')).build(user, ORIGIN);
    const doc = JSON.parse(serializeJsonLd(quads));

    expect(doc['@context'].foaf).toBe('http://xmlns.com/foaf/0.1/');
    const meNode = doc['@graph'].find((n: { '@id': string }) => n['@id'] === WEBID);
    expect(meNode['@type']).toContain(FOAF('Agent'));
    expect(meNode[FOAF('name')]).toEqual({ '@value': 'Ada Lovelace' });
  });
});
