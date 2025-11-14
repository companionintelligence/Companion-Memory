# Events Data Source

Calendar events and scheduled activities (currently optional/commented out in seed script).

## Status

⚠️ **Currently Disabled** - Event seeding is commented out in `main.ts` but the infrastructure exists.

## CSV File Format

**File name:** `{prefix}-events.csv` (e.g., `js1-events.csv`)

**Import order:** 8th (optional, after core data types)

## Purpose

Events represent:
- Calendar appointments
- Scheduled activities
- Recurring events
- Time-based memories

## Implementation

To enable event import:

1. Uncomment in `backend/apps/api/scripts/seed-database/main.ts`:
   ```typescript
   await seedEvents(db, path.resolve(dataDir, './js1-data/js1-events.csv'));
   ```

2. Review `seed-events.ts` for field requirements

3. Create CSV following the expected schema

## Database Schema

Events are stored in the memory domain and can include:
- Event title and description
- Start and end times
- Location information
- Recurrence patterns
- Attendees

## Next Steps

If you need event import:
1. Review the commented-out `seedEvents` function
2. Check the `EventEntity` schema
3. Create appropriate CSV data
4. Uncomment and test the import
5. Update this documentation with field specifications

## Related

- [Places](./places.md) - Location data for events
- [People](./people.md) - Attendees and participants
