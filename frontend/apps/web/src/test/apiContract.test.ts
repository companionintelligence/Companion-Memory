import { memoryContractNotice } from '@ci/common';
import { describe, expect, it } from 'vitest';

describe('memoryContractNotice', () => {
  it('asks for a server update when the health body has no contract', () => {
    expect(memoryContractNotice({ status: 'ok' })).toBe('server');
    expect(memoryContractNotice(undefined)).toBe('server');
  });

  it('stays quiet when this app and the server are on the same floor', () => {
    expect(memoryContractNotice({ apiVersion: 1, minClientVersion: 1 })).toBeNull();
  });

  it('asks for an app update when the server no longer accepts this app', () => {
    expect(memoryContractNotice({ apiVersion: 2, minClientVersion: 2 })).toBe('app');
  });

  it('prefers the server sentence when the server itself is behind', () => {
    expect(memoryContractNotice({ apiVersion: 0, minClientVersion: 9 })).toBe('server');
  });
});
