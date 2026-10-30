import assert from 'node:assert/strict';
import { test } from 'node:test';

import merge from 'deepmerge';

test('deepmerge drops __proto__ when the target has a null prototype', () => {
  const defaults = Object.assign(Object.create(null) as Record<string, unknown>, { debug: false });
  const malicious = JSON.parse('{"__proto__":{"isAdmin":true}}') as Record<string, unknown>;
  const result = merge(defaults, malicious) as Record<string, unknown>;

  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.isAdmin, undefined);
  assert.equal(result.debug, false);
});

test('deepmerge drops nested __proto__ when the target contains a null placeholder', () => {
  const defaults = { session: null };
  const malicious = JSON.parse('{"session":{"__proto__":{"isAdmin":true}}}');
  const result = merge(defaults, malicious) as unknown as { session: Record<string, unknown> };

  assert.equal(Object.getPrototypeOf(result.session), Object.prototype);
  assert.equal(result.session.isAdmin, undefined);
});

test('deepmerge does not copy an own __proto__ key from the target', () => {
  const target = JSON.parse('{"__proto__":{"isAdmin":true},"debug":false}');
  const result = merge(target, { verbose: true }) as Record<string, unknown>;

  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), false);
  assert.equal(result.isAdmin, undefined);
  assert.equal(result.debug, false);
  assert.equal(result.verbose, true);
});

test('deepmerge drops __proto__ in objects cloned from an array', () => {
  const defaults = { list: [] };
  const malicious = JSON.parse('{"list":[{"__proto__":{"isAdmin":true}}]}');
  const result = merge(defaults, malicious) as { list: Record<string, unknown>[] };

  assert.equal(Object.getPrototypeOf(result.list[0]), Object.prototype);
  assert.equal(result.list[0].isAdmin, undefined);
});
