import { createSign } from 'node:crypto';

const API_ROOT = 'https://api.appstoreconnect.apple.com/v1';
const APP_ID = '6803774762';
const POLL_INTERVAL_MS = 60_000;
const PROCESSING_TIMEOUT_MS = 40 * 60_000;

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

export function createAscToken({ issuerId, keyId, privateKey, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({ iss: issuerId, iat: nowSeconds, exp: nowSeconds + 600, aud: 'appstoreconnect-v1' }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');

  return `${signingInput}.${signature}`;
}

function assertBuildNumber(value) {
  if (!/^\d+$/.test(value ?? '')) {
    throw new Error('Set BUILD_NUMBER to the numeric App Store Connect build number to distribute.');
  }
}

async function requestJson(fetchImpl, url, token, init) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`App Store Connect returned HTTP ${response.status}: ${body.slice(0, 1000)}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function findIosBuild(payload, buildNumber) {
  const platforms = new Map(
    (payload.included ?? [])
      .filter((item) => item.type === 'preReleaseVersions')
      .map((item) => [item.id, item.attributes?.platform]),
  );

  return (payload.data ?? []).find((build) => {
    const version = build.attributes?.version;
    const preReleaseVersionId = build.relationships?.preReleaseVersion?.data?.id;

    return version === buildNumber && platforms.get(preReleaseVersionId) === 'IOS';
  });
}

async function findProcessedBuild({ fetchImpl, token, buildNumber, sleepImpl, timeoutMs, nowImpl }) {
  const deadline = nowImpl() + timeoutMs;
  const query = new URLSearchParams({
    'filter[app]': APP_ID,
    'filter[version]': buildNumber,
    include: 'preReleaseVersion',
    'fields[builds]': 'version,processingState,uploadedDate,preReleaseVersion',
    'fields[preReleaseVersions]': 'version,platform',
    limit: '200',
  });

  while (nowImpl() <= deadline) {
    const payload = await requestJson(fetchImpl, `${API_ROOT}/builds?${query}`, token);
    const build = findIosBuild(payload, buildNumber);
    if (build) {
      const state = build.attributes?.processingState;
      if (state === 'VALID') {
        return build;
      }

      if (state === 'FAILED' || state === 'INVALID') {
        throw new Error(`iOS build ${buildNumber} finished processing in state ${state}.`);
      }

      console.log(
        `iOS build ${buildNumber} is ${state ?? 'still processing'}; checking again in 60 seconds.`,
      );
    } else {
      console.log(
        `iOS build ${buildNumber} is not visible in App Store Connect yet; checking again in 60 seconds.`,
      );
    }

    if (nowImpl() + POLL_INTERVAL_MS > deadline) {
      break;
    }

    await sleepImpl(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for iOS build ${buildNumber} to finish App Store Connect processing.`);
}

export async function assignBuildToInternalGroups({
  buildNumber,
  issuerId,
  keyId,
  privateKey,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = Date.now,
  timeoutMs = PROCESSING_TIMEOUT_MS,
}) {
  assertBuildNumber(buildNumber);
  const token = createAscToken({ issuerId, keyId, privateKey });
  const build = await findProcessedBuild({ fetchImpl, token, buildNumber, sleepImpl, timeoutMs, nowImpl });

  const groupsQuery = new URLSearchParams({
    'fields[betaGroups]': 'name,isInternalGroup,hasAccessToAllBuilds',
    limit: '200',
  });
  const groupsPayload = await requestJson(
    fetchImpl,
    `${API_ROOT}/apps/${APP_ID}/betaGroups?${groupsQuery}`,
    token,
  );
  const internalGroups = (groupsPayload.data ?? []).filter((group) => group.attributes?.isInternalGroup);
  if (internalGroups.length === 0) {
    const available = (groupsPayload.data ?? []).map((group) => group.attributes?.name).filter(Boolean);
    throw new Error(
      `No internal TestFlight groups exist for Companion Memory${available.length ? `; found only: ${available.join(', ')}` : ''}. No tester access was changed.`,
    );
  }

  const existingQuery = new URLSearchParams({ 'fields[betaGroups]': 'name,isInternalGroup', limit: '200' });
  const existingPayload = await requestJson(
    fetchImpl,
    `${API_ROOT}/builds/${build.id}/betaGroups?${existingQuery}`,
    token,
  );
  const existingIds = new Set((existingPayload.data ?? []).map((group) => group.id));
  const toAssign = internalGroups.filter(
    (group) => !group.attributes?.hasAccessToAllBuilds && !existingIds.has(group.id),
  );

  if (toAssign.length > 0) {
    await requestJson(fetchImpl, `${API_ROOT}/builds/${build.id}/relationships/betaGroups`, token, {
      method: 'POST',
      body: JSON.stringify({ data: toAssign.map(({ id }) => ({ type: 'betaGroups', id })) }),
    });
  }

  const names = internalGroups.map((group) => group.attributes?.name ?? group.id);
  console.log(
    toAssign.length > 0
      ? `Build ${buildNumber} is available to internal TestFlight groups: ${names.join(', ')}.`
      : `Build ${buildNumber} already has access for all internal TestFlight groups: ${names.join(', ')}.`,
  );
  console.log('External tester groups were left unchanged.');

  return { buildId: build.id, internalGroupNames: names, assignedGroupCount: toAssign.length };
}

async function main() {
  for (const name of ['BUILD_NUMBER', 'APPSTORE_ISSUER_ID', 'APPSTORE_KEY_ID', 'APPSTORE_PRIVATE_KEY']) {
    if (!process.env[name]) {
      throw new Error(`Missing required workflow input or secret: ${name}.`);
    }
  }

  const result = await assignBuildToInternalGroups({
    buildNumber: process.env.BUILD_NUMBER,
    issuerId: process.env.APPSTORE_ISSUER_ID,
    keyId: process.env.APPSTORE_KEY_ID,
    privateKey: process.env.APPSTORE_PRIVATE_KEY,
  });
  console.log(`Distribution complete for iOS build ${process.env.BUILD_NUMBER} (${result.buildId}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
