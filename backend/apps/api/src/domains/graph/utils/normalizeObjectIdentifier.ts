/**
 * The object identifier rule lives in `@ci/common/objectIdentifier`, so domains other than
 * graph can import it without reaching into graph's internals (depcheck's
 * `no-cross-domain-internals`) or importing graph's barrel (which imports memory).
 * This path stays so graph's own importers keep working unchanged.
 */
export * from '@ci/common/objectIdentifier/normalizeObjectIdentifier';
