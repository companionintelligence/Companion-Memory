import { Badge } from '@ci/shadcn';
import { Lock, LockOpen, ShieldCheck, Clock } from '@ci/shadcn/icons';

import { consentLockLabel, type ConsentLockState } from './consentProvenance';

interface Props {
  state: ConsentLockState;
  /** Opens the detail modal. Omitted renders a static badge (used inside the modal's own header). */
  onOpen?: () => void;
  /** Longer form for the row that has space; the compact one is icon + word. */
  size?: 'compact' | 'full';
}

/**
 * The lock — one glanceable summary of what protected a disclosure, and the
 * doorway to the detail.
 *
 * ═══ WHY A CONTROL AND NOT AN ORNAMENT ═══
 *
 * A padlock that only asserts "secure" is worse than no padlock: it trains
 * people to read a shape instead of a fact, which is precisely the habit the
 * browser address bar spent a decade unlearning. So this one is a BUTTON. Every
 * state it can show is a state the owner can open and interrogate, and the
 * states it shows most often are the unremarkable ones.
 *
 * ═══ THE COMMON CASE IS NOT A WARNING ═══
 *
 * `peers.requireHttpSignature` ships off and a local ask never crosses a network
 * boundary, so `consented` — real consent, unsigned channel — is the honest
 * reading of most disclosures. It is rendered as a plain secondary badge, not as
 * a caution. A UI that painted the ordinary case as a problem would teach people
 * to ignore the badge, and then the one time it says something worth reading
 * they would not read it.
 *
 * Only `open` (a disclosure with no consent basis recorded at all) is given the
 * outline treatment that reads as "look at this".
 *
 * Every state is carried in TEXT beside the icon — WCAG 1.4.1, the same rule the
 * rest of the ask surfaces follow. The icon reinforces the word; it never
 * replaces it.
 */
export function ConsentLock({ state, onOpen, size = 'compact' }: Props) {
  const { label, meaning } = consentLockLabel(state);
  const Icon = iconFor(state);
  const variant = variantFor(state);

  const content = (
    <Badge variant={variant} className="gap-1 text-xs font-normal">
      <Icon className="size-3" aria-hidden />
      {label}
      {size === 'full' ? <span className="text-muted-foreground">· {meaning}</span> : null}
    </Badge>
  );

  if (!onOpen) {
    return content;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      // The accessible name carries the MEANING, not just the label: a screen
      // reader user hearing "Signed, button" learns nothing they can act on.
      aria-label={`${label}. ${meaning} Open consent details.`}
      className="focus-visible:ring-ring cursor-pointer rounded-full focus-visible:ring-2 focus-visible:outline-none"
    >
      {content}
    </button>
  );
}

function iconFor(state: ConsentLockState) {
  switch (state) {
    case 'sealed':
      return ShieldCheck;
    case 'consented':
      return Lock;
    case 'pending':
      return Clock;
    case 'open':
    default:
      return LockOpen;
  }
}

function variantFor(state: ConsentLockState): 'default' | 'secondary' | 'outline' {
  switch (state) {
    case 'sealed':
      return 'default';
    case 'consented':
      return 'secondary';
    case 'pending':
      return 'secondary';
    case 'open':
    default:
      // The only state that asks to be looked at. See the note above on why the
      // others deliberately do not.
      return 'outline';
  }
}
