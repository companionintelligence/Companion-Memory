import { GlobalUID } from '../../types/GlobalUID';
import { resolveEventId } from '../ContentResolver';

describe('resolveEventId', () => {
  const uuid = '019ee82a-2f70-71fd-b4a7-2679a8e5140b';

  it('decodes a relay global id (what createEvent returns) to the raw uuid', () => {
    const globalId = GlobalUID.encode('event', uuid);
    expect(resolveEventId(globalId)).toBe(uuid);
  });

  it('passes a bare uuid through unchanged', () => {
    expect(resolveEventId(uuid)).toBe(uuid);
  });

  it('does not mis-decode a global id of another type — leaves it untouched', () => {
    const personGlobalId = GlobalUID.encode('person', uuid);
    // Not an event id; resolveEventId returns it as-is rather than stealing the uuid.
    expect(resolveEventId(personGlobalId)).toBe(personGlobalId);
  });
});
