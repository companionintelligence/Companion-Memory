import { createHash } from 'node:crypto';

/**
 * Twelve digits two people can read to each other to check their link.
 *
 * Made from both `did:key`s, sorted, so each side computes the same number
 * from its own link: mine names your key, yours names mine. If an invite was
 * swapped on the way (someone handed you their code instead of mine), the keys
 * on the two links differ and so do the numbers. Comparing them over a channel
 * the swapper does not control (a call, in person) is what catches it.
 *
 * 40 bits of SHA-256: far more than a person can be made to compare wrongly by
 * chance, few enough to read aloud.
 */
const DOMAIN = 'companion-memory safety code v1\n';

export function safetyCodeFor(didKeyA: string, didKeyB: string): string {
  const [first, second] = [didKeyA, didKeyB].sort();
  const digest = createHash('sha256').update(`${DOMAIN}${first}\n${second}`, 'utf8').digest();
  const value = digest.readBigUInt64BE(0) % 1_000_000_000_000n;
  const digits = value.toString().padStart(12, '0');

  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}`;
}
