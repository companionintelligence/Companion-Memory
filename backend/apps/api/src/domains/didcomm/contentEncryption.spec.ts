import {
  type ContentEncryption,
  contentEncryptionSpec,
  decryptContent,
  encryptContent,
  generateCek,
  hchacha20,
  isContentEncryption,
} from './contentEncryption';
import { DidcommError } from './errors';

const hex = (text: string): Buffer => Buffer.from(text.replace(/\s+/g, ''), 'hex');
const ENCS: ContentEncryption[] = ['A256CBC-HS512', 'A256GCM', 'XC20P'];

describe('HChaCha20', () => {
  it('matches draft-irtf-cfrg-xchacha-03 §2.2.1', () => {
    const key = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const nonce = hex('000000090000004a0000000031415927');

    expect(hchacha20(key, nonce).toString('hex')).toBe(
      '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc',
    );
  });

  it('refuses a wrong key or nonce size', () => {
    expect(() => hchacha20(Buffer.alloc(31), Buffer.alloc(16))).toThrow(DidcommError);
    expect(() => hchacha20(Buffer.alloc(32), Buffer.alloc(24))).toThrow(DidcommError);
  });
});

describe('XC20P', () => {
  it('matches the XChaCha20-Poly1305 AEAD example of draft-irtf-cfrg-xchacha-03 Appendix A.3.1', () => {
    const plaintext = Buffer.from(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const aad = hex('50515253c0c1c2c3c4c5c6c7');
    const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = hex('404142434445464748494a4b4c4d4e4f5051525354555657');

    const sealed = encryptContent('XC20P', key, plaintext, aad, nonce);

    expect(sealed.ciphertext.toString('hex')).toBe(
      'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e',
    );
    expect(sealed.tag.toString('hex')).toBe('c0875924c1c7987947deafd8780acf49');
    expect(decryptContent('XC20P', key, sealed, aad).equals(plaintext)).toBe(true);
  });
});

describe('A256CBC-HS512', () => {
  it('matches RFC 7518 Appendix B.3', () => {
    const key = hex(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
        '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
    );
    const iv = hex('1af38c2dc2b96ffdd86694092341bc04');
    const plaintext = Buffer.from(
      'A cipher system must not be required to be secret, and it must be able to fall into the hands of the enemy without inconvenience',
    );
    const aad = Buffer.from('The second principle of Auguste Kerckhoffs');

    const sealed = encryptContent('A256CBC-HS512', key, plaintext, aad, iv);

    expect(sealed.ciphertext.toString('hex')).toBe(
      '4affaaadb78c31c5da4b1b590d10ffbd3dd8d5d302423526912da037ecbcc7bd' +
        '822c301dd67c373bccb584ad3e9279c2e6d12a1374b77f077553df829410446b' +
        '36ebd97066296ae6427ea75c2e0846a11a09ccf5370dc80bfecbad28c73f09b3' +
        'a3b75e662a2594410ae496b2e2e6609e31e6e02cc837f053d21f37ff4f51950b' +
        'be2638d09dd7a4930930806d0703b1f6',
    );
    expect(sealed.tag.toString('hex')).toBe(
      '4dd3b4c088a7f45c216839645b2012bf2e6269a8c56a816dbc1b267761955bc5',
    );
  });
});

describe.each(ENCS)('%s', (enc) => {
  const aad = Buffer.from('eyJhbGciOiJFQ0RILUVTK0EyNTZLVyJ9');
  const plaintext = Buffer.from('{"id":"1","type":"x","body":{}}');

  it('round-trips with sizes from its specification', () => {
    const spec = contentEncryptionSpec(enc);
    const cek = generateCek(enc);
    const sealed = encryptContent(enc, cek, plaintext, aad);

    expect(cek).toHaveLength(spec.cekBytes);
    expect(sealed.iv).toHaveLength(spec.ivBytes);
    expect(sealed.tag).toHaveLength(spec.tagBytes);
    expect(decryptContent(enc, cek, sealed, aad).equals(plaintext)).toBe(true);
  });

  it('never repeats an IV or a ciphertext for the same input', () => {
    const cek = generateCek(enc);
    const a = encryptContent(enc, cek, plaintext, aad);
    const b = encryptContent(enc, cek, plaintext, aad);

    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('fails identically for a changed ciphertext, tag, IV, AAD or key', () => {
    const cek = generateCek(enc);
    const sealed = encryptContent(enc, cek, plaintext, aad);
    const flip = (buffer: Buffer): Buffer => {
      const copy = Buffer.from(buffer);
      copy[0] ^= 0x01;

      return copy;
    };

    const attempts = [
      () => decryptContent(enc, cek, { ...sealed, ciphertext: flip(sealed.ciphertext) }, aad),
      () => decryptContent(enc, cek, { ...sealed, tag: flip(sealed.tag) }, aad),
      () => decryptContent(enc, cek, { ...sealed, iv: flip(sealed.iv) }, aad),
      () => decryptContent(enc, cek, sealed, flip(aad)),
      () => decryptContent(enc, flip(cek), sealed, aad),
      () => decryptContent(enc, cek, { ...sealed, tag: sealed.tag.subarray(1) }, aad),
      () => decryptContent(enc, cek.subarray(1), sealed, aad),
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrow(DidcommError);
      expect(attempt).toThrow('the message could not be decrypted');
    }
  });

  it('rejects wrong key or IV sizes when encrypting', () => {
    expect(() => encryptContent(enc, Buffer.alloc(5), plaintext, aad)).toThrow(DidcommError);
    expect(() => encryptContent(enc, generateCek(enc), plaintext, aad, Buffer.alloc(3))).toThrow(
      DidcommError,
    );
  });
});

describe('A256CBC-HS512 ciphertext checks', () => {
  it('rejects an empty or misaligned ciphertext before touching AES', () => {
    const cek = generateCek('A256CBC-HS512');
    const sealed = encryptContent('A256CBC-HS512', cek, Buffer.from('x'), Buffer.alloc(0));

    expect(() =>
      decryptContent('A256CBC-HS512', cek, { ...sealed, ciphertext: Buffer.alloc(0) }, Buffer.alloc(0)),
    ).toThrow(DidcommError);
    expect(() =>
      decryptContent(
        'A256CBC-HS512',
        cek,
        { ...sealed, ciphertext: sealed.ciphertext.subarray(1) },
        Buffer.alloc(0),
      ),
    ).toThrow(DidcommError);
  });
});

describe('isContentEncryption', () => {
  it('accepts exactly the three DIDComm values', () => {
    for (const enc of ENCS) {
      expect(isContentEncryption(enc)).toBe(true);
    }

    for (const other of ['A128GCM', 'A256CBC', 'none', '', 'toString', '__proto__', 5, null]) {
      expect(isContentEncryption(other)).toBe(false);
    }
  });
});
