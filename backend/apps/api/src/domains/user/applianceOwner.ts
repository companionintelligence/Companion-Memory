import { timingSafeEqual } from 'node:crypto';

import config from '@ci/configuration';

/**
 * Who may create this appliance's first account.
 *
 * The first account becomes the administrator ({@link UserService}), and until this existed it went
 * to whoever reached an empty appliance first: a password signup, any Portal sign-in, or any person
 * the Hub vouched for. Nothing tied it to the person who installed the box.
 *
 * `auth.applianceOwner` names that person. CI-Hub fills it at install from its owner (the operator
 * who claimed the Hub) as `CI_OWNER_EMAIL`, `CI_OWNER_HUB_ISSUER`/`CI_OWNER_HUB_SUBJECT` and, when
 * the owner has signed in to the Hub with their Companion account, `CI_OWNER_PORTAL_ISSUER`/
 * `CI_OWNER_PORTAL_SUBJECT`. An install without a Hub can set `CI_OWNER_CLAIM_TOKEN`, a setup code
 * the installer types where the form asks for a signup code. With none of them set, the first
 * account is still whoever arrives first.
 *
 * Each door that can create an account gathers what it knows about the person ({@link OwnerEvidence})
 * and asks {@link isDesignatedOwner}. `UserService` refuses, in the transaction that creates the
 * first account, any creation whose caller did not establish that.
 */
export interface OwnerEvidence {
  /** A Portal identity the door verified: an OIDC sign-in's (iss, sub), address and whether the Portal verified it. */
  portal?: {
    issuer?: string | null;
    subject?: string | null;
    email?: string | null;
    emailVerified?: boolean;
  } | null;
  /** A Hub person the Hub vouched for: the signed username and, from a current Hub, their stable id. */
  hub?: { username?: string | null; issuer?: string | null; subject?: string | null } | null;
  /** A setup code the person typed (the signup code field, or `signup_code` on the OIDC link). */
  claimToken?: string | null;
}

/** Thrown inside the transaction creating the first account when the caller did not show it is the owner's. */
export class ApplianceOwnerRequiredError extends Error {
  constructor() {
    super("Only this appliance's owner can create its first account");
    this.name = 'ApplianceOwnerRequiredError';
  }
}

function setting(value: string | undefined | null): string {
  return (value ?? '').trim();
}

function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

function sameAddress(a: string | null | undefined, b: string): boolean {
  return Boolean(a) && a!.trim().toLowerCase() === b.toLowerCase();
}

function sameSecret(offered: string, expected: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether an owner is named at all. When not, the first account is whoever arrives first. */
export function ownerIsDesignated(): boolean {
  const owner = config.auth.applianceOwner;

  return [owner.email, owner.hubSubject, owner.portalSubject, owner.claimToken].some((value) =>
    setting(value),
  );
}

/** Whether the owner can prove it with a setup code, so the signup form should ask for one. */
export function ownerClaimTokenConfigured(): boolean {
  return setting(config.auth.applianceOwner.claimToken) !== '';
}

/** Whether `evidence` shows the person is the designated owner. False whenever no owner is designated. */
export function isDesignatedOwner(evidence: OwnerEvidence): boolean {
  const owner = config.auth.applianceOwner;
  const email = setting(owner.email);
  const hubIssuer = setting(owner.hubIssuer);
  const hubSubject = setting(owner.hubSubject);
  const portalSubject = setting(owner.portalSubject);
  const portalIssuer = setting(owner.portalIssuer) || setting(config.auth.portal.issuer);
  const claimToken = setting(owner.claimToken);
  const { portal, hub } = evidence;

  if (
    portalSubject &&
    portalIssuer &&
    portal?.subject === portalSubject &&
    portal.issuer &&
    sameIssuer(portal.issuer, portalIssuer)
  ) {
    return true;
  }

  if (hubSubject && hubIssuer && hub?.subject === hubSubject && hub.issuer === hubIssuer) {
    return true;
  }

  // An address proves the owner only where someone vouched for it: the Portal verified it, or the
  // Hub signed it as the username of the person it let in.
  if (
    email &&
    ((portal?.emailVerified === true && sameAddress(portal.email, email)) ||
      sameAddress(hub?.username, email))
  ) {
    return true;
  }

  return Boolean(claimToken && evidence.claimToken && sameSecret(evidence.claimToken, claimToken));
}
