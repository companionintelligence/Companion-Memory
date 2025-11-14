# Things Data Source

Inventory items and personal possessions (currently optional/commented out).

## Status

⚠️ **Currently Disabled** - Things/inventory seeding is commented out in `main.ts`.

**Note:** There is a migration script `migrate-things-to-inventory.ts` suggesting this feature evolved.

## CSV File Format

**File name:** `{prefix}-things.csv`

**Import order:** 8th (optional, after core data types)

## Purpose

Things/inventory data could represent:
- Personal possessions
- Items to track
- Inventory management
- Belongings and their metadata

## Migration

The `migrate-things-to-inventory.ts` script suggests:
- Original "things" concept migrated to "inventory"
- Schema likely changed during development
- Review migration script for field mapping

## Implementation

To enable things import:

1. Uncomment in `backend/apps/api/scripts/seed-database/main.ts`:
   ```typescript
   await seedThings(db, path.resolve(dataDir, './js1-data/js1-things.csv'));
   ```

2. Run migration if needed:
   ```bash
   yarn run exec -- scripts/seed-database/migrate-things-to-inventory.ts
   ```

3. Create CSV following current schema

## Next Steps

If you need things/inventory import:
1. Review `seed-things.ts` and `migrate-things-to-inventory.ts`
2. Check the `ThingEntity` schema
3. Understand current vs legacy field structure
4. Create appropriate CSV data
5. Test migration if using legacy data
6. Update this documentation with complete specifications
