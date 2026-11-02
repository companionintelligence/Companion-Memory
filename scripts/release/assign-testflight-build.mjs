import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
  testerEmail,
  resendInvitation = false,
}) {
  assertBuildNumber(buildNumber);
  if (resendInvitation && !testerEmail?.trim()) {
    throw new Error('Set tester_email when resend_invitation is true.');
  }

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
  const allGroups = groupsPayload.data ?? [];
  const internalGroups = allGroups.filter((group) => group.attributes?.isInternalGroup);
  if (internalGroups.length === 0) {
    const available = allGroups.map((group) => group.attributes?.name).filter(Boolean);
    throw new Error(
      `No internal TestFlight groups exist for Companion Memory${available.length ? `; found only: ${available.join(', ')}` : ''}. No tester access was changed.`,
    );
  }

  const buildAccess = new Map();
  for (const group of allGroups) {
    if (group.attributes?.hasAccessToAllBuilds) {
      buildAccess.set(group.id, true);
      continue;
    }

    let nextUrl = `${API_ROOT}/betaGroups/${group.id}/relationships/builds?limit=200`;
    let alreadyAssigned = false;
    while (nextUrl) {
      const existingPayload = await requestJson(fetchImpl, nextUrl, token);
      if ((existingPayload.data ?? []).some((existingBuild) => existingBuild.id === build.id)) {
        alreadyAssigned = true;
        break;
      }

      nextUrl = existingPayload.links?.next ?? '';
    }

    buildAccess.set(group.id, alreadyAssigned);
  }

  const groupsMissingBuild = [];
  for (const group of internalGroups) {
    if (!buildAccess.get(group.id)) {
      groupsMissingBuild.push(group);
    }
  }

  if (groupsMissingBuild.length > 0) {
    await requestJson(fetchImpl, `${API_ROOT}/builds/${build.id}/relationships/betaGroups`, token, {
      method: 'POST',
      body: JSON.stringify({ data: groupsMissingBuild.map(({ id }) => ({ type: 'betaGroups', id })) }),
    });
    for (const group of groupsMissingBuild) {
      buildAccess.set(group.id, true);
    }
  }

  const names = internalGroups.map((group) => group.attributes?.name ?? group.id);
  console.log(
    groupsMissingBuild.length > 0
      ? `Build ${buildNumber} is available to internal TestFlight groups: ${names.join(', ')}.`
      : `Build ${buildNumber} already has access for all internal TestFlight groups: ${names.join(', ')}.`,
  );
  console.log('External tester groups were left unchanged.');

  const testerMemberships = [];
  const resendableTesterIds = [];
  if (testerEmail) {
    const normalizedEmail = testerEmail.trim().toLowerCase();
    for (const group of allGroups) {
      let nextUrl = `${API_ROOT}/betaGroups/${group.id}/betaTesters?fields%5BbetaTesters%5D=email%2Cstate&limit=200`;
      let tester = null;
      while (nextUrl) {
        const testersPayload = await requestJson(fetchImpl, nextUrl, token);
        tester = (testersPayload.data ?? []).find(
          (candidate) => candidate.attributes?.email?.trim().toLowerCase() === normalizedEmail,
        );
        if (tester) {
          break;
        }

        nextUrl = testersPayload.links?.next ?? '';
      }

      if (tester) {
        const groupName = group.attributes?.name ?? group.id;
        const groupType = group.attributes?.isInternalGroup ? 'internal' : 'external';
        const state = tester.attributes?.state ?? 'unknown';
        const hasBuild = buildAccess.get(group.id) ?? false;
        testerMemberships.push({ groupName, groupType, state, hasBuild });
        if (groupType === 'internal' && state === 'INVITED' && hasBuild) {
          resendableTesterIds.push(tester.id);
        }

        console.log(
          `The supplied Apple ID is listed in ${groupType} group "${groupName}" (invite state: ${state}; build ${buildNumber} access: ${hasBuild ? 'yes' : 'no'}).`,
        );
      }
    }

    if (testerMemberships.length === 0) {
      console.log('The supplied Apple ID is not listed in any Companion Memory TestFlight group.');
    }
  }

  if (resendInvitation) {
    const testerIds = [...new Set(resendableTesterIds)];
    if (testerIds.length !== 1) {
      throw new Error(
        'Cannot resend the TestFlight invitation: the supplied Apple ID must have exactly one pending internal tester entry with build access.',
      );
    }

    await requestJson(fetchImpl, `${API_ROOT}/betaTesterInvitations`, token, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'betaTesterInvitations',
          relationships: {
            app: { data: { type: 'apps', id: APP_ID } },
            betaTester: { data: { type: 'betaTesters', id: testerIds[0] } },
          },
        },
      }),
    });
    console.log('Resent the TestFlight invitation to the supplied Apple ID.');
  }

  return {
    buildId: build.id,
    internalGroupNames: names,
    assignedGroupCount: groupsMissingBuild.length,
    testerMemberships,
  };
}

async function main() {
  for (const name of ['BUILD_NUMBER', 'APPSTORE_ISSUER_ID', 'APPSTORE_KEY_ID', 'APPSTORE_PRIVATE_KEY']) {
    if (!process.env[name]) {
      throw new Error(`Missing required workflow input or secret: ${name}.`);
    }
  }

  const workflowInputs = process.env.GITHUB_EVENT_PATH
    ? (JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).inputs ?? {})
    : {};
  const testerEmail = workflowInputs.tester_email?.trim();
  const resendInvitation =
    process.env.RESEND_INVITATION === 'true' ||
    workflowInputs.resend_invitation === true ||
    workflowInputs.resend_invitation === 'true';
  if (testerEmail) {
    process.stdout.write(`::add-mask::${testerEmail}\n`);
  }

  const result = await assignBuildToInternalGroups({
    buildNumber: process.env.BUILD_NUMBER,
    issuerId: process.env.APPSTORE_ISSUER_ID,
    keyId: process.env.APPSTORE_KEY_ID,
    privateKey: process.env.APPSTORE_PRIVATE_KEY,
    testerEmail,
    resendInvitation,
  });
  console.log(`Distribution complete for iOS build ${process.env.BUILD_NUMBER} (${result.buildId}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
