import { type DidDocument } from './didDocument';
import { DidcommError } from './errors';
import { createDidResolver, firstOf, StaticDidResolver } from './resolver';

const KEY = 'did:key:z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V';
const PEER =
  'did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc.Vz6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V';

describe('createDidResolver', () => {
  const resolver = createDidResolver();

  it('resolves did:key and did:peer without any configuration', async () => {
    await expect(resolver.resolve(KEY)).resolves.toMatchObject({ id: KEY });
    await expect(resolver.resolve(PEER)).resolves.toMatchObject({ id: PEER });
  });

  it('does not resolve did:web unless it is configured', async () => {
    await expect(resolver.resolve('did:web:example.com')).rejects.toMatchObject({
      code: 'unsupported-did-method',
    });

    const web = createDidResolver({
      web: { fetchJson: async () => ({ id: 'did:web:example.com' }) },
    });

    await expect(web.resolve('did:web:example.com')).resolves.toMatchObject({ id: 'did:web:example.com' });
  });

  it('refuses did:keri on purpose, and says why', async () => {
    const error = await resolver
      .resolve('did:keri:DEjeMDU8UhmR2yvj5SLxEnNOWiP5J7XdH5vcEyXJnZwk')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DidcommError);
    expect((error as DidcommError).code).toBe('unsupported-did-method');
    expect((error as DidcommError).message).toMatch(/ADR-0013/);
    expect((error as DidcommError).message).toMatch(/ADR-0018/);
  });

  it('will not let a method override smuggle did:keri back in', () => {
    const impostor = { resolve: async (): Promise<DidDocument> => ({ id: 'did:keri:Dx' }) };

    expect(() => createDidResolver({ methods: { keri: impostor } })).toThrow(/did:keri is not resolvable/);
  });

  it('accepts a resolver for another method, such as a KERI-backed did:webs', async () => {
    const webs = { resolve: async (did: string): Promise<DidDocument> => ({ id: did }) };
    const custom = createDidResolver({ methods: { webs } });

    await expect(custom.resolve('did:webs:example.com:EAbc')).resolves.toEqual({
      id: 'did:webs:example.com:EAbc',
    });
  });

  it('refuses unknown methods and anything that is not a bare DID', async () => {
    await expect(resolver.resolve('did:example:alice')).rejects.toMatchObject({
      code: 'unsupported-did-method',
    });
    await expect(
      resolver.resolve(`${KEY}#z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V`),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(resolver.resolve('nonsense')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('checks a custom resolver answered for the DID that was asked for', async () => {
    const liar = { resolve: async (): Promise<DidDocument> => ({ id: 'did:webs:example.com:other' }) };
    const custom = createDidResolver({ methods: { webs: liar } });

    await expect(custom.resolve('did:webs:example.com:asked')).rejects.toMatchObject({
      code: 'did-document-invalid',
    });
  });

  it('wraps a custom resolver crash without leaking its message', async () => {
    const crashing = {
      resolve: async (): Promise<DidDocument> => {
        throw new Error('db password=hunter2');
      },
    };
    const custom = createDidResolver({ methods: { webs: crashing } });
    const error = await custom.resolve('did:webs:example.com:x').catch((e: unknown) => e);

    expect((error as DidcommError).code).toBe('did-resolution-failed');
    expect((error as DidcommError).message).not.toMatch(/hunter2/);
  });
});

describe('StaticDidResolver and firstOf', () => {
  const doc: DidDocument = { id: 'did:example:alice' };

  it('answers from its table only', async () => {
    const table = new StaticDidResolver([doc]);

    await expect(table.resolve('did:example:alice')).resolves.toBe(doc);
    await expect(table.resolve('did:example:bob')).rejects.toMatchObject({ code: 'did-resolution-failed' });
  });

  it('firstOf puts a pinned table in front of the network and reports the last failure', async () => {
    const chained = firstOf(new StaticDidResolver([doc]), createDidResolver());

    await expect(chained.resolve('did:example:alice')).resolves.toBe(doc);
    await expect(chained.resolve(KEY)).resolves.toMatchObject({ id: KEY });
    await expect(chained.resolve('did:example:nobody')).rejects.toMatchObject({
      code: 'unsupported-did-method',
    });
    await expect(firstOf().resolve('did:example:x')).rejects.toBeInstanceOf(DidcommError);
  });
});
