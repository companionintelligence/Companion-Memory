# Content Data Source

User-generated content and media (currently optional/commented out).

## Status

⚠️ **Currently Disabled** - Content seeding is commented out in `main.ts`.

## CSV File Format

**File name:** `{prefix}-content.csv`

**Import order:** 8th (optional, after core data types)

## Purpose

Content data could represent:
- Notes and journal entries
- Saved articles or links
- Photos and media metadata
- Documents and files
- User-created content

## Implementation

To enable content import:

1. Uncomment in `backend/apps/api/scripts/seed-database/main.ts`:
   ```typescript
   await seedContent(db, path.resolve(dataDir, './js1-data/js1-content.csv'));
   ```

2. Review `seed-content.ts` for field requirements

3. Create CSV following the expected schema

## Next Steps

If you need content import:
1. Review the commented-out `seedContent` function
2. Check the `ContentEntity` schema
3. Understand content types and metadata requirements
4. Create appropriate CSV data
5. Uncomment and test the import
6. Update this documentation with complete field specifications

## Related

- [Files](./files.md) - File storage and references (if applicable)
- [Tags](./tags.md) - Content categorization
