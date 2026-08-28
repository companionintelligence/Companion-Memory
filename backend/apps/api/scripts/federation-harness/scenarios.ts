/**
 * The scenario driver: five federated asks, narrated in plain language, each
 * one asserting the consent property it exists to demonstrate.
 *
 * ═══ WHAT PLAYS THE PART OF THE ASKER'S BOX, AND WHY ═══
 *
 * The driver POSTs to box B's `/agent/v1/ask` itself rather than going through
 * box A's `sendPeerAsk` → `OutboundAskService` → `PeerAskClient`. That is not a
 * shortcut around a check; it is forced by one, and the check is right:
 *
 *   `PeerAskClient` runs every peer endpoint through `checkEgressUrl`
 *   (domains/peers/urlPolicy.ts), which requires **https**, a port in
 *   `{'', '443'}`, and a host that is not `localhost`, not `*.localhost`, not
 *   `*.local`, and not a literal loopback/RFC1918 address. A box on
 *   `http://127.0.0.1:13031` fails four of those five rules.
 *
 * It is an SSRF guard on an attacker-influenced field (`memory_endpoint` comes
 * from a directory descriptor), and weakening it — an allowlist entry, a "dev
 * mode" bypass, a widened port set — would put a hole in production code to make
 * a demo run. So the demo does not run that half.
 *
 * What is NOT stubbed, and it is everything that decides disclosure: a real
 * RS256 token from a real issuer, fetched and verified against a real remote
 * JWKS with real issuer/audience/expiry checks; the real
 * `PeerAskController` gates; real `(issuer, subject)` → peer-link attribution;
 * the real grant evaluator; the real disclosure ceilings; the real audit writes.
 * The only thing the driver replaces is who calls `fetch` — box A's outbound
 * client, which contributes a timeout and an audit row and no policy at all.
 *
 * See the README's "The outbound half" section for what it would take to close
 * this, and why it is not free.
 */
import type { Client } from 'pg';

import { mintToken } from './idp';
import { FIXTURE_DAY, ensureActiveGrant, withClient } from './seed';
import { BOXES, type BoxRuntime } from './topology';

// ── narration ────────────────────────────────────────────────────────────────

const DIM = '[2m';
const BOLD = '[1m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const CYAN = '[36m';
const RESET = '[0m';

export interface RunReport {
  passed: number;
  failed: number;
  failures: string[];
}

const report: RunReport = { passed: 0, failed: 0, failures: [] };

function heading(title: string, subtitle: string): void {
  console.log(`\n${BOLD}${CYAN}━━━ ${title}${RESET}`);
  console.log(`${DIM}    ${subtitle}${RESET}\n`);
}

function step(text: string): void {
  console.log(`  ${text}`);
}

function detail(label: string, value: unknown): void {
  console.log(`      ${DIM}${label.padEnd(22)}${RESET} ${format(value)}`);
}

function format(value: unknown): string {
  if (value === undefined) {
    return `${DIM}(absent)${RESET}`;
  }

  if (value === null) {
    return `${DIM}null${RESET}`;
  }

  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

/** Assert, narrate, and remember. A violated invariant fails the run. */
function assert(claim: string, ok: boolean, saw?: unknown): void {
  if (ok) {
    report.passed += 1;
    console.log(`      ${GREEN}✓${RESET} ${claim}`);

    return;
  }

  report.failed += 1;
  report.failures.push(claim);
  console.log(
    `      ${RED}✗${RESET} ${claim}${saw === undefined ? '' : `  ${DIM}(saw ${format(saw)})${RESET}`}`,
  );
}

/** Something true and worth knowing that is NOT a pass/fail claim. */
function finding(text: string): void {
  console.log(`      ${YELLOW}▲${RESET} ${text}`);
}

// ── transports ───────────────────────────────────────────────────────────────

export interface PeerAskWire {
  status: number;
  body: {
    askId?: string;
    status?: string;
    reason?: string;
    answer?: {
      form?: string;
      summary?: string;
      items?: { id: string; type: string }[];
      disclosedCount?: number;
      withheldCount?: number;
      busy?: { start: string; end: string }[];
      free?: { start: string; end: string }[];
    };
  };
}

let askCounter = 0;

/**
 * Send one federated ask from box A to box B.
 *
 * The token is minted for A's SUBJECT and B's AUDIENCE. That pairing is the
 * whole binding: `PeerAskController` passes B's own `peers.audience` to
 * `verifyClaims` as the ONLY acceptable audience, so a token addressed to A is
 * rejected here even though both boxes trust the same issuer.
 */
export async function askPeer(
  responder: BoxRuntime,
  request: Record<string, unknown>,
  prompt: string,
  idpIssuer: string,
  /**
   * Reuse a correlation id from an earlier ask instead of minting a new one.
   *
   * `askId` is an IDEMPOTENCY KEY, so this is how a repeat is driven: same key,
   * same question, and the responder replays what it already decided rather
   * than creating a second ask. Minting a fresh id — which is what every other
   * call here does — is a genuinely different ask and is treated as one.
   */
  askId?: string,
): Promise<PeerAskWire> {
  askCounter += 1;

  const token = await mintToken({
    subject: BOXES.a.subject,
    audience: BOXES.b.audience,
    issuer: idpIssuer,
  });

  const response = await fetch(`http://127.0.0.1:${responder.apiPort}/agent/v1/ask`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      // `peerAskBodySchema` requires 8–64 characters matching
      // PEER_ASK_ID_PATTERN; a short counter alone is rejected as 'Malformed
      // ask' with no hint about which field.
      askId: askId ?? `fedharness-${String(askCounter).padStart(4, '0')}-${Date.now()}`,
      askerHandle: BOXES.a.handle,
      prompt,
      request,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as PeerAskWire['body'];

  // The inbound limiter is 10 asks per 60s per (issuer, subject) — a run uses 7,
  // so a 429 means something re-ran inside the window. Say so rather than
  // letting it surface as an unexplained assertion failure.
  if (response.status === 429) {
    throw new Error(
      'box B rate-limited the harness (PeerRateLimitService: 10 asks / 60s per peer identity). ' +
        'Wait a minute and re-run, or restart box B to clear its in-memory window.',
    );
  }

  return { status: response.status, body };
}

/**
 * COLLECT the answer to an ask already sent — `GET /agent/v1/ask/:askId`.
 *
 * The return path for an ask a human approved, which had no channel at all
 * before: `POST /agent/v1/ask`'s synchronous reply was the only one there was,
 * so an approved answer stayed on the responder's box forever.
 *
 * It spends the POLL budget (30/60s), not the ask budget (10/60s) — collecting
 * an answer must not consume the allowance that exists to protect a human's
 * review inbox.
 */
export async function collectPeerAsk(
  responder: BoxRuntime,
  askId: string,
  idpIssuer: string,
): Promise<PeerAskWire> {
  const token = await mintToken({
    subject: BOXES.a.subject,
    audience: BOXES.b.audience,
    issuer: idpIssuer,
  });

  const response = await fetch(
    `http://127.0.0.1:${responder.apiPort}/agent/v1/ask/${encodeURIComponent(askId)}`,
    { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
  );

  const body = (await response.json().catch(() => ({}))) as PeerAskWire['body'];

  if (response.status === 429) {
    throw new Error(
      'box B rate-limited the harness on the COLLECT route (30 polls / 60s per peer identity).',
    );
  }

  return { status: response.status, body };
}

/** Owner-authenticated GraphQL against one box. */
export async function graphql<T>(
  runtime: BoxRuntime,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${runtime.apiPort}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': runtime.apiKey ?? '' },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };

  if (payload.errors?.length) {
    throw new Error(`GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`);
  }

  return payload.data as T;
}

/** `GlobalUID.encode` — base64 of "<type>:<uuid>". */
function gid(type: string, id: string): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

// ── the responder's own records ──────────────────────────────────────────────

interface AskRow {
  id: string;
  status: string;
  direction: string;
  consent_basis: string | null;
  disclosure_ceiling: string | null;
  peer_link_id: string | null;
}

interface AuditRow {
  outcome: string;
  consent_basis: string | null;
  peer_handle: string | null;
  disclosed_entities: string[];
  disclosed_count: number;
  backing_entities: string[];
}

/** The newest inbound ask on the responder, i.e. the one just sent. */
async function latestInboundAsk(client: Client, ownerUserId: string): Promise<AskRow> {
  const { rows } = await client.query<AskRow>(
    `SELECT id, status, direction, consent_basis, disclosure_ceiling, peer_link_id
       FROM ci.asks
      WHERE responder_user_id = $1 AND direction = 'inbound'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [ownerUserId],
  );

  if (rows.length === 0) {
    throw new Error('no inbound ask row on the responder — the ask never reached the box');
  }

  return rows[0];
}

/**
 * How many inbound asks this peer link has produced.
 *
 * The unit the idempotency claim is measured in: "the repeat did not create a
 * second ask" is a COUNT, and a wire reply cannot show it. Before `askId` was
 * read as a key, every repeat added one to this number.
 */
async function countInboundAsks(client: Client, peerLinkId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ci.asks WHERE peer_link_id = $1 AND direction = 'inbound'`,
    [peerLinkId],
  );

  return Number(rows[0].n);
}

async function auditFor(client: Client, askId: string): Promise<AuditRow[]> {
  const { rows } = await client.query<AuditRow>(
    `SELECT outcome, consent_basis, peer_handle, disclosed_entities, disclosed_count, backing_entities
       FROM ci.ask_audit WHERE ask_id = $1 ORDER BY created_at ASC`,
    [askId],
  );

  return rows;
}

async function answerFor(
  client: Client,
  askId: string,
): Promise<{ form: string; summary: string | null; disclosed_count: number; withheld_count: number } | null> {
  const { rows } = await client.query(
    `SELECT form, summary, disclosed_count, withheld_count FROM ci.ask_answers WHERE ask_id = $1`,
    [askId],
  );

  return rows[0] ?? null;
}

/** Narrate the responder's own paper trail for an ask. */
async function showResponderRecord(client: Client, ask: AskRow): Promise<AuditRow[]> {
  const audit = await auditFor(client, ask.id);
  const answer = await answerFor(client, ask.id);

  console.log(`\n      ${DIM}— what box B recorded —${RESET}`);
  detail('ci.asks.status', ask.status);
  detail('ci.asks.consent_basis', ask.consent_basis);
  detail('disclosure_ceiling', ask.disclosure_ceiling);
  detail('ci.ask_answers', answer ? `${answer.form}: "${answer.summary}"` : undefined);

  for (const row of audit) {
    detail('ci.ask_audit.outcome', row.outcome);
    detail('  disclosed_count', row.disclosed_count);
    detail('  disclosed_entities', `${row.disclosed_entities.length} ref(s) — what the peer received`);
    detail('  backing_entities', `${row.backing_entities.length} entity(ies) — what it was computed over`);
    detail('  peer_handle', row.peer_handle);
  }

  console.log('');

  return audit;
}

// ── the scenarios ────────────────────────────────────────────────────────────

export interface Context {
  boxA: BoxRuntime;
  boxB: BoxRuntime;
  idpIssuer: string;
  /** box B's local user id — the responder/owner. */
  responderUserId: string;
  /** the peer-link row on box B that represents box A. */
  peerLinkId: string;
  grants: Record<string, string>;
}

/**
 * (a) A standing grant answers without interrupting anyone.
 */
async function scenarioAuto(ctx: Context): Promise<AskRow> {
  heading(
    'a · AUTO — a standing grant answers on its own',
    `${BOXES.a.displayName} asks ${BOXES.b.displayName} about events. Devon wrote a standing "auto" grant for that class, so no human is interrupted.`,
  );

  step(
    `${BOLD}Ada asks:${RESET} "have you got anything about the design standup?"  ${DIM}(content / events)${RESET}`,
  );

  const wire = await askPeer(
    ctx.boxB,
    { archetype: 'content', subject: 'design standup', dataClass: 'events' },
    'have you got anything about the design standup?',
    ctx.idpIssuer,
  );

  step(
    `${BOLD}Devon's Companion replies:${RESET} ${wire.body.status}  ${DIM}"${wire.body.answer?.summary ?? wire.body.reason}"${RESET}`,
  );
  detail('form', wire.body.answer?.form);
  detail('items', `${wire.body.answer?.items?.length ?? 0} reference(s)`);
  detail('disclosedCount', wire.body.answer?.disclosedCount);

  const ask = await withClient(ctx.boxB, async (client) => {
    const row = await latestInboundAsk(client, ctx.responderUserId);
    const audit = await showResponderRecord(client, row);
    const answerCount = (await answerFor(client, row.id))?.disclosed_count ?? 0;

    assert('the ask is answered on the wire', wire.body.status === 'answered', wire.body.status);
    assert(
      'no item references crossed — the peer protocol exposes no retrieval',
      (wire.body.answer?.items?.length ?? 0) === 0,
    );
    assert('the responder reached a terminal state', row.status === 'answered', row.status);
    assert('it was attributed to the peer link, not a local user', row.peer_link_id === ctx.peerLinkId);
    assert(
      'the audit names the standing grant that authorized it',
      audit.length === 1 && audit[0].consent_basis === ctx.grants['auto/events'],
      audit[0]?.consent_basis,
    );
    assert(
      'the audit records it as AUTO-answered, not owner-answered',
      audit[0]?.outcome === 'auto_answered',
      audit[0]?.outcome,
    );

    // ═══ THE MAGNITUDE THE FEDERATED AUDIT USED TO DROP ═══
    //
    // `ci.ask_audit.disclosed_count` exists precisely because
    // `disclosed_entities` is empty for every form but `retrieval`, so deriving
    // the count from it "audited a real count/boolean disclosure as nothing was
    // shared" (AskAuditService.record's own comment). The LOCAL path passes it:
    // `AskService.completeWithAnswer` forwards `disclosure.answer.disclosedCount`.
    // The FEDERATED path did not — `PeerAskService.recordAudit` had no such
    // parameter at all — so the fallback fired and the row read 0 while a real
    // count crossed the wire. This run used to print `disclosed_count = 0` next
    // to a peer that had just been told "1 matching item".
    const crossed = wire.body.answer?.disclosedCount ?? 0;
    assert(
      'the audit records the magnitude that actually crossed, not the (empty) itemization',
      crossed > 0 && audit[0]?.disclosed_count === crossed,
      { crossedToPeer: crossed, recordedInAudit: audit[0]?.disclosed_count },
    );
    assert('and the answer row and the audit row agree about it', answerCount === crossed, {
      inAnswerRow: answerCount,
      crossedToPeer: crossed,
    });

    return row;
  });

  const inbox = await graphql<{ askInbox: { id: string }[] }>(ctx.boxB, '{ askInbox { id } }');
  assert(
    'the owner was never interrupted — it is not in their review inbox',
    !inbox.askInbox.some((entry) => entry.id === gid('ask', ask.id)),
  );

  return ask;
}

/**
 * (b) No matching grant means owner review — the documented floor.
 */
async function scenarioReview(ctx: Context): Promise<PeerAskWire> {
  heading(
    'b · REVIEW — no standing grant, so a human decides',
    `Ada asks about documents. Devon holds no grant covering that class, and "review" is the floor: there is never implicit open access.`,
  );

  step(
    `${BOLD}Ada asks:${RESET} "do you have the quarterly review deck?"  ${DIM}(content / documents)${RESET}`,
  );

  // The correlation id is minted HERE and reused below: `askId` is an
  // idempotency key, and collecting the approved answer means naming the same
  // ask again rather than asking a second question.
  const correlationId = `fedharness-review-${Date.now()}`;

  const wire = await askPeer(
    ctx.boxB,
    { archetype: 'content', subject: 'quarterly review deck', dataClass: 'documents' },
    'do you have the quarterly review deck?',
    ctx.idpIssuer,
    correlationId,
  );

  step(`${BOLD}Devon's Companion replies:${RESET} ${wire.body.status}  ${DIM}"${wire.body.reason}"${RESET}`);

  const ask = await withClient(ctx.boxB, async (client) => {
    const row = await latestInboundAsk(client, ctx.responderUserId);

    assert(
      'the peer is told nothing beyond "no answer yet"',
      wire.body.status === 'pending',
      wire.body.status,
    );
    assert('nothing was disclosed with it', wire.body.answer === undefined);
    assert('the responder parked it under review', row.status === 'under_review', row.status);
    assert(
      'with no consent basis — no grant authorized anything',
      row.consent_basis === null,
      row.consent_basis,
    );

    return row;
  });

  const inbox = await graphql<{ askInbox: { id: string; query: { prompt: string } }[] }>(
    ctx.boxB,
    '{ askInbox { id query { prompt dataClass } } }',
  );
  const inboxEntry = inbox.askInbox.find((entry) => entry.id === gid('ask', ask.id));
  step(
    `${BOLD}Devon opens their inbox${RESET} and sees: ${DIM}"${inboxEntry?.query.prompt ?? '(missing)'}"${RESET}`,
  );
  assert('it is waiting in the owner’s review inbox', inboxEntry != null);

  step(`${BOLD}Devon approves it${RESET}, then runs it.`);
  const approved = await graphql<{ approveAsk: { success: boolean; ask: { status: string } } }>(
    ctx.boxB,
    'mutation($id: ID!) { approveAsk(id: $id) { success ask { status } } }',
    { id: gid('ask', ask.id) },
  );
  assert(
    'approve moves it to `answering`',
    approved.approveAsk.ask.status === 'answering',
    approved.approveAsk.ask.status,
  );

  const ran = await graphql<{
    runAsk: {
      success: boolean;
      disclosedCount: number | null;
      ask: { status: string };
      answer: { form: string; summary: string } | null;
    };
  }>(
    ctx.boxB,
    'mutation($id: ID!) { runAsk(id: $id) { success disclosedCount ask { status } answer { form summary } } }',
    { id: gid('ask', ask.id) },
  );
  detail(
    'answer',
    ran.runAsk.answer ? `${ran.runAsk.answer.form}: "${ran.runAsk.answer.summary}"` : undefined,
  );

  await withClient(ctx.boxB, async (client) => {
    const row = await latestInboundAsk(client, ctx.responderUserId);
    const audit = await showResponderRecord(client, row);

    assert('the ask is answered', row.status === 'answered', row.status);
    assert(
      'the audit records an owner-answered disclosure',
      audit.some((a) => a.outcome === 'answered'),
    );

    // ═══ A DISCLOSURE HISTORY THAT CANNOT NAME WHO IT WENT TO ═══
    //
    // The AUTO path writes this row itself and stamps `peer_link_id` +
    // `peer_handle` (see (a), where it reads "ada"). The REVIEW path does not:
    // the owner answers through `runAsk` → `AskService.completeWithAnswer`,
    // whose audit row is "built from the ask alone and cannot carry peerLinkId
    // / peerHandle" — PeerAskService's own docstring says so, and names
    // teaching `complete` to carry peer attribution as the follow-up.
    //
    // The consequence, reproduced here end to end: the ONE disclosure a human
    // personally approved for a peer is the one the owner's history cannot
    // attribute. Asserted as the CURRENT behaviour rather than as the desired
    // one, so the day it is fixed this line fails and gets deleted.
    const owner = audit.find((a) => a.outcome === 'answered');
    assert(
      'KNOWN GAP, pinned: an owner-approved federated disclosure records NO peer_handle',
      owner?.peer_handle === null,
      owner?.peer_handle,
    );
  });

  finding('THE REVIEW PATH LOSES PEER ATTRIBUTION. Compare the audit rows: the auto-answered one in (a)');
  finding('names `ada`, this one names nobody. `runAsk` goes through AskService.completeWithAnswer,');
  finding('which builds its audit row from the ask alone — so "who did I share this with?" has no');
  finding('answer for exactly the disclosures a human looked at and approved.');

  // ── the return path ────────────────────────────────────────────────────────
  //
  // This is where the run used to end with a shrug. The synchronous reply to
  // `POST /agent/v1/ask` was the only channel there was — no callback, no poll,
  // no delivery — and `askId` was documented as an idempotency key that nothing
  // read, so asking again minted a NEW ci.asks row, was re-evaluated from
  // scratch, and landed in front of Devon a second time. The answer a human had
  // personally approved sat on Devon's box forever.
  const asksBefore = await withClient(ctx.boxB, (client) => countInboundAsks(client, ctx.peerLinkId));

  step(`${BOLD}Ada collects the answer${RESET} — ${DIM}GET /agent/v1/ask/${correlationId}${RESET}`);

  const collected = await collectPeerAsk(ctx.boxB, correlationId, ctx.idpIssuer);

  step(
    `${BOLD}Devon's Companion hands it over:${RESET} ${collected.body.status}  ${DIM}"${collected.body.answer?.summary ?? collected.body.reason}"${RESET}`,
  );
  detail('form', collected.body.answer?.form);
  detail('disclosedCount', collected.body.answer?.disclosedCount);

  assert(
    'THE APPROVED ANSWER CROSSES BACK — the review path is no longer one-way',
    collected.body.status === 'answered',
    collected.body.status,
  );
  assert(
    'it is the answer Devon approved, not a re-run',
    collected.body.answer?.summary === ran.runAsk.answer?.summary,
    { collected: collected.body.answer?.summary, approved: ran.runAsk.answer?.summary },
  );
  assert(
    'still no item references — a replay is never wider than the live answer was',
    (collected.body.answer?.items?.length ?? 0) === 0,
    collected.body.answer?.items,
  );

  const asksAfterCollect = await withClient(ctx.boxB, (client) => countInboundAsks(client, ctx.peerLinkId));
  assert(
    'collecting creates NOTHING — it evaluates no grant and writes no ask',
    asksAfterCollect === asksBefore,
    { before: asksBefore, after: asksAfterCollect },
  );

  step(`${BOLD}And asking again with the same id${RESET} replays it rather than re-asking.`);

  const again = await askPeer(
    ctx.boxB,
    { archetype: 'content', subject: 'quarterly review deck', dataClass: 'documents' },
    'do you have the quarterly review deck?',
    ctx.idpIssuer,
    correlationId,
  );

  const asksAfterRepeat = await withClient(ctx.boxB, (client) => countInboundAsks(client, ctx.peerLinkId));

  assert('the repeat is the SAME ask, replayed — no second ci.asks row', asksAfterRepeat === asksBefore, {
    before: asksBefore,
    after: asksAfterRepeat,
  });
  assert('and it carries the approved answer too', again.body.status === 'answered', again.body.status);

  // ── the oracle the collect route must not become ───────────────────────────
  step(`${BOLD}Ada tries an id Devon has never seen.${RESET}`);

  const unknown = await collectPeerAsk(ctx.boxB, `fedharness-never-sent-${Date.now()}`, ctx.idpIssuer);

  step(
    `${BOLD}Devon's Companion replies:${RESET} ${unknown.body.status}  ${DIM}"${unknown.body.reason}"${RESET}`,
  );
  assert(
    'an unknown id is the ordinary non-answer, not a 404 — "have I ever asked that?" is not free',
    unknown.status === 200 && unknown.body.status === 'pending',
    { http: unknown.status, status: unknown.body.status },
  );

  finding('THE RETURN PATH IS A POLL, NOT A CALLBACK. A callback would invert who has to be reachable —');
  finding('the RESPONDER would need egress to an address the ASKER supplied, i.e. a second and more');
  finding('directly attacker-controlled SSRF sink, on the box that holds the data — and it would make a');
  finding('home appliance an inbound server for its peers. The poll costs latency and nothing else: it');
  finding('evaluates no grant, runs no executor, writes no ask and writes no audit row.');

  // The pending reply is handed to (c) as the thing its refusal is held up
  // against. It is a REAL reply off the wire, not a fixture: a synthesized one
  // cannot notice that Nest answers `@Post` with 201, which is exactly the kind
  // of difference the comparison exists to catch.
  return wire;
}

/**
 * (c) A block refuses, and tells the asker nothing a pending ask would not.
 */
async function scenarioBlock(ctx: Context, pending: PeerAskWire): Promise<void> {
  heading(
    'c · BLOCK — a refusal that leaks nothing',
    `Devon blocked the "messages" class outright. The refusal must not tell Ada that a block exists, rather than that Devon simply has not got to it.`,
  );

  step(`${BOLD}Ada asks:${RESET} "have you got messages from Priya?"  ${DIM}(content / messages)${RESET}`);

  const wire = await askPeer(
    ctx.boxB,
    { archetype: 'content', subject: 'messages from Priya', dataClass: 'messages' },
    'have you got messages from Priya?',
    ctx.idpIssuer,
  );

  step(`${BOLD}Devon's Companion replies:${RESET} ${wire.body.status}  ${DIM}"${wire.body.reason}"${RESET}`);

  await withClient(ctx.boxB, async (client) => {
    const row = await latestInboundAsk(client, ctx.responderUserId);
    const audit = await showResponderRecord(client, row);

    assert(
      'the peer is told nothing beyond "no answer yet"',
      wire.body.status === 'pending',
      wire.body.status,
    );
    assert(
      'the responder recorded the refusal as terminal, not actionable',
      row.status === 'declined',
      row.status,
    );
    assert('the audit records a declined outcome', audit[0]?.outcome === 'declined', audit[0]?.outcome);
    assert(
      'nothing was disclosed',
      audit[0]?.disclosed_count === 0 && audit[0]?.disclosed_entities.length === 0,
    );
  });

  const inbox = await graphql<{ askInbox: { id: string }[] }>(ctx.boxB, '{ askInbox { id } }');
  assert('a blocked ask never becomes actionable in the owner’s inbox', inbox.askInbox.length >= 0);

  // ── the indistinguishability claim, stated precisely ───────────────────────
  console.log(
    `\n      ${DIM}— compared field by field against the awaiting-a-human reply from (b) —${RESET}`,
  );
  detail('blocked  →', { status: wire.body.status, reason: wire.body.reason, answer: wire.body.answer });
  detail('pending  →', {
    status: pending.body.status,
    reason: pending.body.reason,
    answer: pending.body.answer,
  });
  console.log('');

  assert(
    'the refusal carries no answer object at all — same shape as pending',
    wire.body.answer === undefined,
  );
  assert('it carries no count', wire.body.answer === undefined);
  assert(
    'it names no grant, no class and no reason beyond a constant',
    wire.body.reason === 'No answer is available',
    wire.body.reason,
  );
  assert(
    'both replies carry the SAME HTTP status — the refusal is not a status-code oracle',
    wire.status === pending.status,
    `${wire.status} vs ${pending.status}`,
  );

  // ═══ AND NOW THE WORD ITSELF ═══
  //
  // Everything BELOW the status word was already identical. The word was not:
  // `declined` for a block, `pending_review` for an ask awaiting a human — a
  // one-bit read on the grant matrix, mappable at 10 probes a minute by varying
  // queryType and dataClass. #2210/#2216 closed exactly that for a LOCAL asker
  // (`ASK_ACCEPTED` is a constant, `askerVisibleStatus` folds every non-answered
  // status to `delivered`) and left the federated path emitting it, while
  // `SendPeerAskPayload`'s docstring cited the federated path as the precedent.
  //
  // The collapse is made at the RESPONDER, not on receipt: hiding it on the
  // asker's box would bind only a well-behaved asker while the word stayed on
  // the wire.
  // Everything except the correlation id, which is the ASKER's own and differs
  // by construction — it is echoed straight back, and is the one field in the
  // reply that carries no information about the responder at all.
  const withoutAskId = ({ askId: _askId, ...rest }: PeerAskWire['body']) => JSON.stringify(rest);

  assert(
    'the two replies are now IDENTICAL, field for field — the status word is no longer an oracle',
    withoutAskId(wire.body) === withoutAskId(pending.body),
    { blocked: wire.body, pending: pending.body },
  );

  finding('WHAT THE ASKER LOSES BY THIS, AND WHY IT NO LONGER MATTERS. The responder arguably owed a peer');
  finding('a real answer to "should I wait?" — that was the honest argument for keeping `pending_review`.');
  finding('It is answered instead by the ask being POLLABLE: an asker that wants to know whether an answer');
  finding('arrived asks for it by id and is told, rather than inferring it from a consent posture.');
}

/**
 * (d) A grant's disclosure ceiling makes the answer narrower than the
 *     relationship alone would allow.
 */
async function scenarioCeiling(ctx: Context): Promise<void> {
  heading(
    'd · CEILING — "how many, never when"',
    `Devon's availability grant carries scope.maxDisclosure = 'count'. The trust tier alone would allow real interval boundaries; the ceiling cuts it to a number.`,
  );

  const window = { from: `${FIXTURE_DAY}T15:00:00.000Z`, to: `${FIXTURE_DAY}T23:59:00.000Z` };

  step(`${BOLD}Ada asks:${RESET} "free for lunch on ${FIXTURE_DAY}?"  ${DIM}(availability)${RESET}`);

  const capped = await askPeer(
    ctx.boxB,
    { archetype: 'availability', ...window, minMinutes: 45, purpose: 'lunch' },
    `free for lunch on ${FIXTURE_DAY}?`,
    ctx.idpIssuer,
  );

  step(
    `${BOLD}Devon's Companion replies:${RESET} ${capped.body.status}  ${DIM}"${capped.body.answer?.summary}"${RESET}`,
  );
  detail('busy intervals', `${capped.body.answer?.busy?.length ?? 0}`);
  detail('free intervals', `${capped.body.answer?.free?.length ?? 0}`);

  const backing = await withClient(ctx.boxB, async (client) => {
    const row = await latestInboundAsk(client, ctx.responderUserId);
    const audit = await showResponderRecord(client, row);

    assert('the ask is answered', capped.body.status === 'answered', capped.body.status);
    assert(
      'NO busy intervals crossed',
      (capped.body.answer?.busy?.length ?? 0) === 0,
      capped.body.answer?.busy,
    );
    assert(
      'NO free intervals crossed',
      (capped.body.answer?.free?.length ?? 0) === 0,
      capped.body.answer?.free,
    );
    assert(
      'the summary is the count-only sentence — magnitude, not instants',
      /free slot/.test(capped.body.answer?.summary ?? ''),
      capped.body.answer?.summary,
    );
    assert(
      'but the box DID read the owner’s real calendar to say it (audit backing_entities)',
      (audit[0]?.backing_entities.length ?? 0) > 0,
      audit[0]?.backing_entities.length,
    );
    assert('the availability disclosure is recorded, under the `attribute` storage form', audit.length === 1);

    // The availability branch is the harder half of the same defect: it
    // itemizes NOTHING by construction, so `disclosed_entities.length` is 0 and
    // always was — the fallback could never be right here. The answer row said
    // 4 and the audit row said 0.
    const slots = (await answerFor(client, row.id))?.disclosed_count ?? 0;
    assert(
      'and the audit records the same number of free slots the answer row does',
      slots > 0 && audit[0]?.disclosed_count === slots,
      { inAnswerRow: slots, inAudit: audit[0]?.disclosed_count },
    );

    return audit[0]?.backing_entities.length ?? 0;
  });

  step(`${DIM}The answer was computed over ${backing} real meeting(s) and none of them crossed.${RESET}`);

  // ── the control: same ask, ceiling removed ─────────────────────────────────
  step(
    `${BOLD}Devon revokes the capped grant${RESET} and writes an uncapped one, to show the ceiling was doing the work.`,
  );

  await graphql(ctx.boxB, 'mutation($id: ID!) { revokeAskGrant(id: $id) { success } }', {
    id: gid('ask-grant', ctx.grants['auto/calendar capped at count']),
  });

  // Written as SQL, not through `createAskGrant`. That mutation takes only a
  // `granteeId` (a USER global id) and hard-codes `granteeUserId` — there is no
  // way to address a grant to a PEER LINK through GraphQL at all, even though
  // `GrantService.create` and the DB CHECK both support it. See the README.
  const control = await withClient(ctx.boxB, (client) =>
    ensureActiveGrant(client, ctx.responderUserId, ctx.peerLinkId, {
      label: 'control/uncapped availability',
      queryType: 'availability',
      dataClass: 'calendar',
      mode: 'auto',
      scope: null,
      why: 'the control for the ceiling scenario — revoked again at the end',
    }),
  );

  const uncapped = await askPeer(
    ctx.boxB,
    { archetype: 'availability', ...window, minMinutes: 45, purpose: 'lunch' },
    `free for lunch on ${FIXTURE_DAY}?`,
    ctx.idpIssuer,
  );

  step(`${BOLD}Same question, no ceiling:${RESET} ${DIM}"${uncapped.body.answer?.summary}"${RESET}`);
  detail('busy intervals', `${uncapped.body.answer?.busy?.length ?? 0}`);
  detail('free intervals', `${uncapped.body.answer?.free?.length ?? 0}`);

  assert(
    'without the ceiling the SAME calendar discloses actual interval boundaries',
    (uncapped.body.answer?.busy?.length ?? 0) + (uncapped.body.answer?.free?.length ?? 0) > 0,
    { busy: uncapped.body.answer?.busy?.length, free: uncapped.body.answer?.free?.length },
  );
  assert(
    'so the capped answer was strictly narrower, not merely an empty calendar',
    (capped.body.answer?.free?.length ?? 0) < (uncapped.body.answer?.free?.length ?? 0),
  );

  finding('A CEILING CANNOT BE RAISED THROUGH THE API, ONLY THROUGH REVOKE + RE-CREATE. `updateAskGrant`');
  finding('MERGES scope, and an omitted `maxDisclosure` inherits the existing one — so there is no input');
  finding('that removes a ceiling. That is the safe direction to be missing, and it is why this control');
  finding('had to revoke first.');

  // Put the topology back: the control grant is not part of the seeded posture.
  await graphql(ctx.boxB, 'mutation($id: ID!) { revokeAskGrant(id: $id) { success } }', {
    id: gid('ask-grant', control.id),
  });
}

/**
 * (e) Revoking mid-flight narrows, never widens.
 */
async function scenarioRevocation(ctx: Context, answered: AskRow): Promise<void> {
  heading(
    'e · REVOCATION — withdrawing consent can only ever tighten',
    `Devon revokes the standing grant from (a). The same question must not come back with MORE — a red team once proved revocation WIDENED disclosure, because a revoked grant reads as "no ceiling" on every SQL path.`,
  );

  const before = await withClient(ctx.boxB, async (client) => {
    const audit = await auditFor(client, answered.id);

    return {
      status: answered.status,
      consentBasis: answered.consent_basis,
      auditRows: audit.length,
      count: audit[0]?.disclosed_count,
    };
  });

  step(`${BOLD}Devon taps Revoke${RESET} on the standing "events" grant.`);
  const revoked = await graphql<{
    revokeAskGrant: {
      success: boolean;
      grant: { revokedAt: string | null; revocationReason: string | null; active: boolean };
    };
  }>(
    ctx.boxB,
    'mutation($id: ID!) { revokeAskGrant(id: $id) { success grant { revokedAt revocationReason active } } }',
    { id: gid('ask-grant', ctx.grants['auto/events']) },
  );
  detail('revoked_at', revoked.revokeAskGrant.grant.revokedAt);
  detail('revocation_reason', revoked.revokeAskGrant.grant.revocationReason);
  assert('the grant is no longer in force', revoked.revokeAskGrant.grant.active === false);
  assert(
    'and it is recorded as revoked, not superseded',
    revoked.revokeAskGrant.grant.revocationReason === 'revoked',
  );

  step(`${BOLD}Ada asks the identical question again.${RESET}`);

  const wire = await askPeer(
    ctx.boxB,
    { archetype: 'content', subject: 'design standup', dataClass: 'events' },
    'have you got anything about the design standup?',
    ctx.idpIssuer,
  );

  step(
    `${BOLD}Devon's Companion replies:${RESET} ${wire.body.status}  ${DIM}"${wire.body.reason ?? wire.body.answer?.summary}"${RESET}`,
  );

  await withClient(ctx.boxB, async (client) => {
    const row = await latestInboundAsk(client, ctx.responderUserId);
    await showResponderRecord(client, row);

    assert('the re-ask is NOT auto-answered any more', wire.body.status !== 'answered', wire.body.status);
    assert('it discloses nothing', wire.body.answer === undefined);
    assert('it lands in front of the owner instead', row.status === 'under_review', row.status);
    assert('with the pre-authorization stripped', row.consent_basis === null, row.consent_basis);

    // The other half of the property: revocation must not REWRITE what already
    // happened. `withdrawPreAuthorization` selects `status = 'delivered'`, and
    // the answered ask from (a) is terminal — outside that filter.
    const after = await client.query<AskRow>(
      `SELECT id, status, direction, consent_basis, disclosure_ceiling, peer_link_id FROM ci.asks WHERE id = $1`,
      [answered.id],
    );
    const afterAudit = await auditFor(client, answered.id);

    assert(
      'the disclosure already made in (a) is untouched — still `answered`',
      after.rows[0].status === 'answered' && before.status === 'answered',
      after.rows[0].status,
    );
    assert(
      'its consent basis still names the (now revoked) grant, so the history resolves',
      after.rows[0].consent_basis === before.consentBasis && after.rows[0].consent_basis != null,
    );
    assert(
      'no second, contradicting audit row was written for it',
      afterAudit.length === before.auditRows && afterAudit[0]?.disclosed_count === before.count,
      afterAudit.length,
    );
  });

  finding('The ceiling captured on `ci.asks.disclosure_ceiling` at consent time is what makes this safe on');
  finding('the local path too: the answer path combines it with the LIVE grant via `narrowestRung`, so a');
  finding('revoked grant (invisible to every `revoked_at IS NULL` read) can no longer erase the cap it set.');
}

// ── the run ──────────────────────────────────────────────────────────────────

export async function runScenarios(ctx: Context): Promise<RunReport> {
  console.log(`\n${BOLD}Two Companions, one question at a time.${RESET}`);
  console.log(
    `${DIM}  ${BOXES.a.displayName}  handle @${BOXES.a.handle}   sub ${BOXES.a.subject}   :${ctx.boxA.apiPort}${RESET}`,
  );
  console.log(
    `${DIM}  ${BOXES.b.displayName}  handle @${BOXES.b.handle}   sub ${BOXES.b.subject}   :${ctx.boxB.apiPort}${RESET}`,
  );
  console.log(
    `${DIM}  issuer ${ctx.idpIssuer}  ·  every token is addressed to "${BOXES.b.audience}"${RESET}`,
  );

  const answered = await scenarioAuto(ctx);
  const pending = await scenarioReview(ctx);

  await scenarioBlock(ctx, pending);

  await scenarioCeiling(ctx);
  await scenarioRevocation(ctx, answered);

  return report;
}
