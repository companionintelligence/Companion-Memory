import type { ComponentType, ReactNode } from 'react';

import { Badge, Dialog } from '@ci/shadcn';
import { KeyRound, Radio, ShieldAlert } from '@ci/shadcn/icons';

import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import { rungLabel, type DisclosureRung, type GrantMode } from './askPresentation';
import { ConsentLock } from './ConsentLock';
import {
  channelSentence,
  consentLockState,
  consentSentence,
  coveredComponentPurpose,
  formatMoment,
  uncoveredComponents,
  type ChannelFacts,
  type ConsentSource,
} from './consentProvenance';

/** Everything the modal can say about one disclosure. */
export interface ConsentRecord {
  /** Who asked. Opaque when that is all the wire supports — never invented. */
  askerName: string;
  consent: ConsentSource;
  channel: ChannelFacts;
  /** The ceiling that capped this disclosure, when one applied. */
  ceiling?: DisclosureRung | null;
  /** The standing grant's posture, when a grant decided it. */
  grantMode?: GrantMode | null;
  /** When the request arrived. */
  arrivedAt: string;
  /** Where it came from. A local ask never crosses a network boundary. */
  direction: 'local' | 'inbound' | 'outbound';
  /** Whether the request carried a body — decides if `content-digest` was required. */
  hasBody: boolean;
  /**
   * Whether channel facts were recorded at all for this disclosure.
   *
   * DISTINCT FROM an unsigned channel, and the distinction is the whole reason
   * the flag exists. `ci.ask_audit` is the durable disclosure record and does
   * not yet carry channel provenance (`ci.asks` does), so a Disclosure History
   * row honestly cannot say how the request arrived. Rendering that as
   * "unsigned" would assert a fact nobody checked. Defaults to true.
   */
  channelRecorded?: boolean;
}

interface Props {
  record: ConsentRecord;
  onClose: () => void;
}

/**
 * The signature modal — what protected this disclosure, in full.
 *
 * The lock is a summary and a summary is not evidence, so this is where the two
 * axes are separated and each is shown on its own terms:
 *
 *   CONSENT  — what authorized the disclosure.
 *   CHANNEL  — how the request arrived, and what its signature actually covered.
 *   COLLECTED — when it arrived and over what path.
 *
 * ═══ WHY THE SIGNATURE GETS A TABLE ═══
 *
 * A list of covered component names is not an explanation. `"@target-uri"` tells
 * an owner nothing; *"stops the same signature being replayed against a
 * different endpoint"* tells them what they would lose without it. So each
 * covered component is rendered with the thing it protects, and the ones that
 * are MISSING are named too — a reader comparing two signatures should not have
 * to know the required set by heart to notice one is short.
 *
 * ═══ THE UNSIGNED CASE IS A SECTION, NOT A BLANK ═══
 *
 * Most disclosures are unsigned today, and the section still renders: it says so
 * in a sentence and explains what that means. An owner who cannot tell "arrived
 * unsigned" from "we did not record how it arrived" cannot act on either.
 */
export function ConsentDetailModal({ record, onClose }: Props) {
  const fmt = useDateTimeFormat();
  const channelRecorded = record.channelRecorded ?? true;
  const state = consentLockState({
    consent: record.consent,
    // An unrecorded channel cannot raise the lock to `sealed`: the lock shows
    // the weaker of the two axes, and "we did not look" is not evidence.
    channel: channelRecorded ? record.channel : { keyThumbprint: null, verifiedAt: null, covered: [] },
  });
  const signed = channelRecorded && record.channel.keyThumbprint != null && record.channel.verifiedAt != null;
  const missing = signed ? uncoveredComponents(record.channel.covered, record.hasBody) : [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[620px]">
        <Dialog.Header>
          <Dialog.Title className="flex flex-wrap items-center gap-2">
            How this was protected
            <ConsentLock state={state} />
          </Dialog.Title>
          <Dialog.Description>
            Two separate things govern a disclosure, and they can fail separately: what authorized it, and how
            the request reached you.
          </Dialog.Description>
        </Dialog.Header>

        <div className="flex flex-col gap-5 text-sm">
          {/* ── Consent ──────────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <SectionHeading>What authorized this</SectionHeading>
            <p className="text-muted-foreground">{consentSentence(record.consent, record.askerName)}</p>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              {record.grantMode ? (
                <Row term="Grant posture" value={grantPostureLabel(record.grantMode)} />
              ) : null}
              <Row
                term="Most that could be shared"
                value={
                  record.ceiling
                    ? rungLabel(record.ceiling)
                    : 'No ceiling was set — the trust tier’s default applied.'
                }
              />
            </dl>
          </section>

          {/* ── Channel ──────────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <SectionHeading>How it reached you</SectionHeading>
            <p className="text-muted-foreground">
              {channelRecorded
                ? channelSentence(record.channel, record.askerName)
                : 'How this request arrived was not recorded for this disclosure. Your Companion began keeping that record after this one.'}
            </p>

            {signed ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <Row
                    term="Signing key"
                    // Full value, selectable: the abbreviated form belongs in
                    // prose, not in the row somebody might need to compare.
                    value={<code className="break-all">{record.channel.keyThumbprint}</code>}
                    icon={KeyRound}
                  />
                  <Row
                    term="Verified by you at"
                    value={formatMoment(record.channel.verifiedAt as string, fmt)}
                  />
                  <Row term="Algorithm" value="Ed25519 (RFC 9421 HTTP Message Signatures)" />
                </dl>

                <p className="text-muted-foreground mt-1 text-xs">What the signature covers:</p>
                <ul className="flex flex-col gap-1.5">
                  {record.channel.covered.map((component) => {
                    const purpose = coveredComponentPurpose(component);

                    return (
                      <li key={component} className="bg-muted rounded-md px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <code>{component}</code>
                          <span className="font-medium">{purpose.title}</span>
                        </div>
                        <p className="text-muted-foreground">{purpose.protects}</p>
                      </li>
                    );
                  })}
                </ul>

                {missing.length > 0 ? (
                  // Named rather than merely absent: a short signature is the
                  // one thing a reader most needs pointed out, and spotting it
                  // otherwise means knowing the required set by heart.
                  <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                    <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span>Not covered by this signature: {missing.map((c) => c).join(', ')}.</span>
                  </p>
                ) : null}
              </>
            ) : null}
          </section>

          {/* ── Collection ───────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <SectionHeading>When and how it was collected</SectionHeading>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <Row term="Arrived" value={formatMoment(record.arrivedAt, fmt)} icon={Radio} />
              <Row term="Path" value={pathLabel(record.direction)} />
              <Row term="Asked by" value={record.askerName} />
            </dl>
          </section>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold tracking-wide uppercase">{children}</h3>;
}

function Row({
  term,
  value,
  icon: Icon,
}: {
  term: string;
  value: ReactNode;
  icon?: ComponentType<{ className?: string }>;
}) {
  return (
    <>
      <dt className="text-muted-foreground flex items-center gap-1.5 whitespace-nowrap">
        {Icon ? <Icon className="size-3" /> : null}
        {term}
      </dt>
      <dd className="min-w-0">{value}</dd>
    </>
  );
}

/**
 * The grant's posture in the owner's words.
 *
 * `block` cannot reach this modal — a blocked ask discloses nothing, so there is
 * no disclosure to explain — but it is handled rather than defaulted, because a
 * mode falling through to "Answers automatically" would be the worst possible
 * wrong answer.
 */
function grantPostureLabel(mode: GrantMode): ReactNode {
  switch (mode) {
    case 'auto':
      return <Badge variant="default">Answers automatically</Badge>;
    case 'block':
      return <Badge variant="destructive">Blocked</Badge>;
    case 'review':
    default:
      return <Badge variant="secondary">Asks you first</Badge>;
  }
}

function pathLabel(direction: ConsentRecord['direction']): string {
  switch (direction) {
    case 'inbound':
      return 'From another Companion, over HTTPS to your box';
    case 'outbound':
      return 'Sent from your Companion to another';
    case 'local':
    default:
      // Worth stating: it is the reason a local ask is never signed, and
      // without it "unsigned" reads as a gap rather than as a non-question.
      return 'Within your own Companion — it never crossed a network';
  }
}
