import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignBuildToInternalGroups, createAscToken } from './release/assign-testflight-build.mjs';

const APP_ID = '6803774762';
const TESTER_EMAIL = 'liam.broza@gmail.com';

test('creates an App Store Connect ES256 token with the expected claims', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const token = createAscToken({
    issuerId: 'issuer-test',
    keyId: 'key-test',
    privateKey: privatePem,
    nowSeconds: 1_800_000_000,
  });
  const [header, payload, signature] = token.split('.');
  const signingInput = `${header}.${payload}`;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), {
    alg: 'ES256',
    kid: 'key-test',
    typ: 'JWT',
  });
  assert.deepEqual(claims, {
    iss: 'issuer-test',
    iat: 1_800_000_000,
    exp: 1_800_000_600,
    aud: 'appstoreconnect-v1',
  });
  assert.equal(
    verify(
      'sha256',
      Buffer.from(signingInput),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
});

test('assigns a processed iOS build to internal groups only', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (url.startsWith('https://api.appstoreconnect.apple.com/v1/builds?')) {
      return Response.json({
        data: [
          {
            id: 'build-1024',
            type: 'builds',
            attributes: { version: '1024', processingState: 'VALID' },
            relationships: { preReleaseVersion: { data: { id: 'ios-version', type: 'preReleaseVersions' } } },
          },
          {
            id: 'mac-build-1024',
            type: 'builds',
            attributes: { version: '1024', processingState: 'VALID' },
            relationships: { preReleaseVersion: { data: { id: 'mac-version', type: 'preReleaseVersions' } } },
          },
        ],
        included: [
          {
            id: 'ios-version',
            type: 'preReleaseVersions',
            attributes: { version: '1.0.9', platform: 'IOS' },
          },
          {
            id: 'mac-version',
            type: 'preReleaseVersions',
            attributes: { version: '1.0.9', platform: 'MAC_OS' },
          },
        ],
      });
    }

    if (
      url ===
      `https://api.appstoreconnect.apple.com/v1/apps/${APP_ID}/betaGroups?fields%5BbetaGroups%5D=name%2CisInternalGroup%2ChasAccessToAllBuilds&limit=200`
    ) {
      return Response.json({
        data: [
          {
            id: 'internal-group',
            type: 'betaGroups',
            attributes: { name: 'Internal QA', isInternalGroup: true, hasAccessToAllBuilds: false },
          },
          {
            id: 'external-group',
            type: 'betaGroups',
            attributes: { name: 'External QA', isInternalGroup: false, hasAccessToAllBuilds: false },
          },
          {
            id: 'all-builds-group',
            type: 'betaGroups',
            attributes: { name: 'All Builds', isInternalGroup: true, hasAccessToAllBuilds: true },
          },
        ],
      });
    }

    if (
      url ===
      'https://api.appstoreconnect.apple.com/v1/betaGroups/internal-group/relationships/builds?limit=200'
    ) {
      return Response.json({ data: [] });
    }

    if (
      url ===
      'https://api.appstoreconnect.apple.com/v1/betaGroups/external-group/relationships/builds?limit=200'
    ) {
      return Response.json({ data: [{ id: 'build-1024', type: 'builds' }] });
    }

    if (url.startsWith('https://api.appstoreconnect.apple.com/v1/betaGroups/internal-group/betaTesters?')) {
      return Response.json({
        data: [
          {
            id: 'tester-internal',
            type: 'betaTesters',
            attributes: { email: TESTER_EMAIL, state: 'ACCEPTED' },
          },
        ],
      });
    }

    if (url.startsWith('https://api.appstoreconnect.apple.com/v1/betaGroups/external-group/betaTesters?')) {
      return Response.json({ data: [] });
    }

    if (url.startsWith('https://api.appstoreconnect.apple.com/v1/betaGroups/all-builds-group/betaTesters?')) {
      return Response.json({ data: [] });
    }

    if (
      url === 'https://api.appstoreconnect.apple.com/v1/builds/build-1024/relationships/betaGroups' &&
      method === 'POST'
    ) {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected request ${method} ${url}`);
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.join(' '));
  let result;
  try {
    result = await assignBuildToInternalGroups({
      buildNumber: '1024',
      issuerId: 'issuer-test',
      keyId: 'key-test',
      privateKey: privatePem,
      fetchImpl,
      nowImpl: () => 0,
      testerEmail: TESTER_EMAIL,
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(result, {
    buildId: 'build-1024',
    internalGroupNames: ['Internal QA', 'All Builds'],
    assignedGroupCount: 1,
    testerMemberships: [
      { groupName: 'Internal QA', groupType: 'internal', state: 'ACCEPTED', hasBuild: true },
    ],
  });
  assert.match(logs.join('\n'), /listed in internal group "Internal QA" \(invite state: ACCEPTED/);
  assert.doesNotMatch(logs.join('\n'), new RegExp(TESTER_EMAIL));
  const assignment = requests.find(({ method }) => method === 'POST');
  assert.deepEqual(assignment?.body, { data: [{ type: 'betaGroups', id: 'internal-group' }] });
});
