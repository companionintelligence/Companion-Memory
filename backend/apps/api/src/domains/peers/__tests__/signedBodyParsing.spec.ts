import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';

import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import {
  BodyParserMiddleware,
  type RawBodyRequest,
  transportHasBody,
} from '@ci/common/middleware/BodyParserMiddleware';
import { InMemoryConsumptionStore } from '@ci/domains/consumption';

import { PeerSignatureService } from '../services/PeerSignatureService';

const peersConfig: Record<string, unknown> = {};

jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'peers') {
          return peersConfig;
        }

        return (jest.requireActual('@ci/configuration').default as Record<string, unknown>)[prop];
      },
    },
  ),
}));

const TARGET = 'https://us.example/agent/v1/ask';
const BODY = JSON.stringify({ askId: 'abc12345', prompt: 'do you know David Miller' });

function logger() {
  return { setContext: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

/** A request stream as node hands it to express, carrying `bytes` as its body. */
function incoming(bytes: Buffer, headers: Record<string, string>): RawBodyRequest {
  const req = Readable.from([bytes]) as unknown as RawBodyRequest;
  Object.assign(req, {
    method: 'POST',
    url: '/agent/v1/ask',
    originalUrl: '/agent/v1/ask',
    path: '/agent/v1/ask',
    baseUrl: '',
    headers: { 'content-length': String(bytes.length), ...headers },
  });

  return req;
}

/** Run the REAL middleware (real express parsers) and resolve once it calls `next`. */
function parse(req: RawBodyRequest): Promise<void> {
  const middleware = new BodyParserMiddleware({ get: () => undefined } as unknown as Reflector);

  return new Promise((resolve, reject) => {
    try {
      middleware.use(req as Request, {} as Response, (error?: unknown) =>
        error ? reject(error) : resolve(),
      );
    } catch (error) {
      reject(error);
    }
  });
}

function signedPeer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  peersConfig.signingKeyJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
  const signer = new PeerSignatureService(new InMemoryConsumptionStore(), logger() as never);
  const headers = signer.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY }) as Record<
    string,
    string
  >;
  delete peersConfig.signingKeyJwk;

  return { headers, publicJwk: publicKey.export({ format: 'jwk' }) };
}

async function verify(req: RawBodyRequest, publicJwk: unknown) {
  const verifier = new PeerSignatureService(new InMemoryConsumptionStore(), logger() as never);

  return verifier.verifyInbound({
    method: 'POST',
    targetUri: TARGET,
    signatureInput: req.headers['signature-input'] as string,
    signature: req.headers.signature as string,
    contentDigestHeader: req.headers['content-digest'] as string,
    transportHasBody: transportHasBody(req.headers),
    rawBody: req.rawBody,
    peerPublicJwk: publicJwk,
  });
}

describe('a signed peer body through the real body parser', () => {
  it.each(['application/json', 'application/json; charset=utf-8'])(
    'verifies an honest signed JSON request sent as %s',
    async (contentType) => {
      const peer = signedPeer();
      const req = incoming(Buffer.from(BODY, 'utf8'), { ...peer.headers, 'content-type': contentType });

      await parse(req);

      expect(req.rawBody).toBe(BODY);
      expect(req.body).toEqual(JSON.parse(BODY));
      expect(await verify(req, peer.publicJwk)).toEqual({ ok: true, keyThumbprint: expect.any(String) });
    },
  );

  /**
   * The same signed bytes re-declared in another charset: `json()` would read
   * them as different text from the UTF-8 the digest covers. Refused before
   * any parser runs, so nothing is ever decoded under the wrong charset.
   */
  it.each(['application/json; charset=utf-7', 'application/json; charset=utf-16'])(
    'refuses the same signed request re-sent as %s with 415',
    async (contentType) => {
      const peer = signedPeer();
      const req = incoming(Buffer.from(BODY, 'utf8'), { ...peer.headers, 'content-type': contentType });

      await expect(parse(req)).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(req.rawBody).toBeUndefined();
      expect(req.body).toBeUndefined();
    },
  );
});
