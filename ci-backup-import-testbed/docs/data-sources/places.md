# Places Data Source

Locations and geographic data (currently optional/commented out).

## Status

⚠️ **Currently Disabled** - Places seeding is commented out in `main.ts`.

**Note:** Migration scripts exist: `migrate-places-to-entities.ts` and `migrate-locations-to-position.ts`

## CSV File Format

**File name:** `{prefix}-places.csv` and `{prefix}-locations.csv`

**Import order:** 8th (optional, after core data types)

## Purpose

Places and locations data represents:
- Favorite locations
- Frequently visited places
- Geographic waypoints
- Address information
- Position/coordinate data

## Migration Scripts

Two migration scripts suggest schema evolution:

1. **`migrate-places-to-entities.ts`**
   - Migrates old place data to new entity structure
   - Suggests "places" became more generic "entities"

2. **`migrate-locations-to-position.ts`**
   - Converts location format
   - Likely updates coordinate/position representation

## Implementation

To enable places import:

1. Uncomment in `backend/apps/api/scripts/seed-database/main.ts`:
   ```typescript
   await seedPlaces(db, path.resolve(dataDir, './js1-data/js1-places.csv'));
   await seedLocations(db, path.resolve(dataDir, './js1-data/js1-locations.csv'));
   ```

2. Run migrations if needed for legacy data

3. Create CSV following current schema

## Potential Fields

Based on typical location schemas:
- Name/label
- Address components (street, city, state, zip, country)
- Coordinates (latitude, longitude)
- Place type (home, work, favorite, etc.)
- Metadata (notes, visit frequency, etc.)

## Next Steps

If you need places/locations import:
1. Review seed and migration scripts
2. Check `PlaceEntity` schema
3. Understand coordinate format requirements
4. Create appropriate CSV data
5. Test migrations if using legacy data
6. Update this documentation with complete specifications

## Related

- [Events](./events.md) - Events can reference places
