import { Test } from '@nestjs/testing';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';

import { DidcommController } from '../DidcommController';
import { DISCOVER_FEATURES_PROTOCOL } from '../discoverFeatures';
import { generateDidPeerIdentity, secretsOf } from '../identity';
import { OOB_PROTOCOL } from '../outOfBand';
import { packEncrypted } from '../pack';
import { createDidResolver } from '../resolver';
import { buildPing, TRUST_PING_PROTOCOL } from '../trustPing';

describe('DidcommController HTTP discovery, OOB 2.0, and Trust Ping', () => {
  it('returns 404 for all DIDComm endpoints when didcomm.messaging is disabled', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DidcommController],
      providers: [
        { provide: FeatureService, useValue: { isFeatureEnabled: jest.fn().mockResolvedValue(false) } },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    const server = app.getHttpServer();

    await request(server).get('/didcomm/did').expect(404);
    await request(server).post('/didcomm/oob').send({}).expect(404);
    await request(server).post('/didcomm/oob/parse').send({ url: 'https://x.test?_oob=a' }).expect(404);
    await request(server).post('/didcomm/message').send({}).expect(404);

    await app.close();
  });

  it('publishes protocols, round-trips OOB 2.0 invitations offline, and answers Trust Ping', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DidcommController],
      providers: [
        { provide: FeatureService, useValue: { isFeatureEnabled: jest.fn().mockResolvedValue(true) } },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    const server = app.getHttpServer();

    const didRes = await request(server).get('/didcomm/did').expect(200);
    expect(didRes.body.did).toMatch(/^did:peer:2\./);
    expect(didRes.body.protocols).toEqual(
      expect.arrayContaining([TRUST_PING_PROTOCOL, DISCOVER_FEATURES_PROTOCOL, OOB_PROTOCOL]),
    );
    expect(didRes.body.accept).toEqual(['didcomm/v2']);

    const oobRes = await request(server)
      .post('/didcomm/oob')
      .send({
        goalCode: 'ci.peer.connect',
        goal: 'Connect trusted companion',
        baseUrl: 'https://hub.example/connect',
      })
      .expect(201);

    expect(oobRes.body.invitation.type).toBe('https://didcomm.org/out-of-band/2.0/invitation');
    expect(oobRes.body.invitation.from).toBe(didRes.body.did);
    expect(oobRes.body.invitationUrl).toContain('https://hub.example/connect?_oob=');

    const parsedRes = await request(server)
      .post('/didcomm/oob/parse')
      .send({ url: oobRes.body.invitationUrl })
      .expect(201);
    expect(parsedRes.body).toEqual({
      valid: true,
      invitation: oobRes.body.invitation,
    });

    const ssrfRes = await request(server)
      .post('/didcomm/oob/parse')
      .send({ url: 'https://attacker.example/connect?_oobid=secret-token' })
      .expect(201);
    expect(ssrfRes.body.valid).toBe(false);
    expect(ssrfRes.body.code).toBe('unsupported-algorithm');

    await request(server)
      .post('/didcomm/oob')
      .send({ baseUrl: 'http://insecure.example/connect' })
      .expect(400);

    // End-to-end encrypted Trust Ping into POST /didcomm/message
    const sender = generateDidPeerIdentity({
      uri: 'https://sender.local/didcomm',
      accept: ['didcomm/v2'],
    });
    const ping = buildPing({
      from: sender.did,
      to: [didRes.body.did],
      responseRequested: true,
    });
    const packed = await packEncrypted(ping, {
      to: didRes.body.did,
      from: sender.did,
      resolver: createDidResolver(),
      secrets: secretsOf(sender),
    });

    const pingRes = await request(server)
      .post('/didcomm/message')
      .send(JSON.parse(packed.packed))
      .expect(201);
    expect(pingRes.body.handled).toBe(true);
    expect(pingRes.body.type).toBe('https://didcomm.org/trust-ping/2.0/ping');
    expect(pingRes.body.repliesCount).toBe(1);
    expect(pingRes.body.replies[0].type).toBe('https://didcomm.org/trust-ping/2.0/ping-response');

    await app.close();
  });
});
