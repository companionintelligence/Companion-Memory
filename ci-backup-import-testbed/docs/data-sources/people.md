# People Data Source

Contacts, relationships, and people in the user's life (currently optional/commented out).

## Status

⚠️ **Currently Disabled** - People/contacts seeding is commented out in `main.ts`.

## CSV File Format

**File name:** `{prefix}-people.csv` or `{prefix}-contacts.csv`

**Import order:** 8th (optional, after core data types)

## Purpose

People data represents:
- Family members
- Friends and social connections
- Professional contacts
- Relationships and their context

## Implementation

To enable people/contacts import:

1. Uncomment in `backend/apps/api/scripts/seed-database/main.ts`:
   ```typescript
   await seedPeople(db, path.resolve(dataDir, './js1-data/js1-people.csv'));
   await seedContacts(db, path.resolve(dataDir, './js1-data/js1-contacts.csv'));
   ```

2. Review `seed-people.ts` for field requirements

3. Create CSV following the expected schema

## Potential Fields

Based on typical person/contact schemas:
- Name (first, last, full)
- Relationship type (family, friend, colleague, etc.)
- Contact information (phone, email, address)
- Important dates (birthday, anniversary)
- Notes and context

## Next Steps

If you need people/contacts import:
1. Review the commented-out seed functions
2. Check the `PersonEntity` schema
3. Create appropriate CSV data
4. Uncomment and test the import
5. Update this documentation with complete field specifications
