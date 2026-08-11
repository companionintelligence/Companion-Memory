/** Nest/jest stand-in for {@link GraphDeltaWriter} — trail is out of scope for these unit tests. */
export function noopGraphDeltaWriter() {
  return {
    entityCreated: jest.fn(async () => undefined),
    entityUpdated: jest.fn(async () => undefined),
    entityDeleted: jest.fn(async () => undefined),
    recordMany: jest.fn(async () => undefined),
    record: jest.fn(async () => undefined),
  };
}
