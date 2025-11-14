# Data Import Process Guide

This guide provides detailed instructions for importing data into the CI-Server database using the CSV-based seeding system.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Import Process](#import-process)
3. [Data Preparation](#data-preparation)
4. [Testing Your Import](#testing-your-import)
5. [Troubleshooting](#troubleshooting)
6. [Migration Utilities](#migration-utilities)

## Prerequisites

Before importing data, ensure you have:

- ✅ CI-Server development environment set up (`make init`)
- ✅ PostgreSQL database running (`make infra`)
- ✅ Database migrations applied (`make migrate`)
- ✅ Node.js environment configured
- ✅ Access to source data in a format you can convert to CSV

## Import Process

### Step 1: Understand Your Data Model

Review the [data source specifications](./data-sources/) to understand:
- Required vs. optional fields for each data type
- Data type requirements (UUID, Date, Boolean, etc.)
- Relationships between data types
- Field constraints and validation rules

### Step 2: Prepare CSV Files

1. **Export your source data** to CSV format
2. **Map fields** from your source to CI-Server fields
3. **Generate UUIDs** for all `id` fields (use UUIDv7 for time-ordered IDs)
4. **Format dates** to ISO 8601 with timezone
5. **Validate references** to ensure foreign keys will resolve

Example UUID generation in Node.js:
```javascript
import { v7 as uuidv7 } from 'uuid';

const userId = uuidv7(); // e.g., 01933a4d-cc3c-4c25-ad81-078ddc6e29fe
```

### Step 3: Organize CSV Files

Place your CSV files in the seed data directory:

```
backend/apps/api/scripts/seed-database/
├── providers-data/
│   └── providers.csv
├── intelligence-data/
│   └── questions.csv
└── js1-data/          # Or your custom directory name
    ├── js1-users.csv
    ├── js1-answers.csv
    ├── js1-threads.csv
    ├── js1-actions.csv
    ├── js1-messages.csv
    ├── js1-events.csv    # Optional
    ├── js1-people.csv    # Optional
    ├── js1-content.csv   # Optional
    ├── js1-things.csv    # Optional
    └── js1-places.csv    # Optional
```

### Step 4: Configure the Seed Script

If using a custom directory name, update `backend/apps/api/scripts/seed-database/main.ts`:

```typescript
// Update the paths to point to your CSV files
await seedUsers(db, path.resolve(dataDir, './your-data/users.csv'));
await seedAnswers(db, path.resolve(dataDir, './your-data/answers.csv'));
// ... etc
```

### Step 5: Set Environment Variables

Ensure your `.env` file contains:

```bash
# Default password for seeded users (will be hashed with bcrypt)
AUTH_DEFAULT_USER_PASSWORD="]60.a6{CJ}lB*rHAp;w;"

# Database connection (usually from docker-compose)
DB_HOST=localhost
DB_PORT=5432
DB_DATABASE=companion_intelligence
DB_USERNAME=postgres
DB_PASSWORD=postgres
```

### Step 6: Run the Import

Execute the seed command:

```bash
make seed
```

Or run directly:

```bash
cd backend/apps/api
yarn run exec -- scripts/seed-database/main.ts
```

### Step 7: Verify the Import

Check the import logs for:
- ✅ Success messages for each data type
- ⚠️ Warning messages for skipped records (already exist)
- ❌ Error messages indicating failures

Example successful output:
```
[seed-users.ts] Seeded user: jsmith@example.com
[seed-users.ts] Seeded 1 user records
[seed-questions.ts] Seeded 42 question records
[seed-answers.ts] Seeded 156 answer records
...
```

## Data Preparation

### Generating UUIDs

**Option 1: Batch generation with Node.js**

```javascript
import { v7 as uuidv7 } from 'uuid';
import { parse, stringify } from 'csv-parse/sync';
import fs from 'fs';

// Read CSV without IDs
const input = fs.readFileSync('input.csv', 'utf8');
const records = parse(input, { columns: true });

// Add UUIDs
const withIds = records.map(record => ({
  id: uuidv7(),
  ...record
}));

// Write output
const output = stringify(withIds, { header: true });
fs.writeFileSync('output.csv', output);
```

**Option 2: Excel formula**

While Excel can't generate UUIDv7, you can use an online UUID generator and paste values.

**Option 3: Command line (macOS/Linux)**

```bash
# Generate 10 UUIDs (note: these are UUIDv4, not time-ordered)
for i in {1..10}; do uuidgen; done
```

### Converting Date Formats

**From US format (MM/DD/YYYY) to ISO 8601:**

```javascript
function convertDate(usDate) {
  const [month, day, year] = usDate.split('/');
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00Z`;
}

// Example: "5/20/2025" → "2025-05-20T00:00:00Z"
```

**Excel formula to ISO 8601:**

```excel
=TEXT(A1,"yyyy-mm-dd")&"T00:00:00Z"
```

### Handling Missing Data

- **Required fields:** Must be present; provide sensible defaults if source is missing
- **Optional fields:** Can be empty in CSV (will import as NULL)
- **Boolean fields:** Use lowercase `true` or `false`
- **Numeric fields:** Use plain numbers without formatting (e.g., `42`, not `42.0` or `42,000`)

### Escaping Special Characters

CSV standard rules apply:
- Wrap fields containing commas in double quotes: `"Smith, John"`
- Escape double quotes by doubling them: `"He said ""Hello"""`
- Newlines within fields are allowed if the field is quoted

## Testing Your Import

### Test with a Subset First

1. Create a test CSV with 2-3 records
2. Import and verify the data appears correctly
3. Check for any error messages
4. Once verified, proceed with the full dataset

### Validation Checklist

After import, verify:

- [ ] All expected records were created
- [ ] No duplicate records exist
- [ ] Foreign key relationships are intact (user_id references users, etc.)
- [ ] Dates are in the correct timezone
- [ ] Text fields don't have encoding issues (check for garbled characters)
- [ ] Boolean values imported correctly (true/false, not 1/0)

### Database Queries for Verification

```sql
-- Count imported users
SELECT COUNT(*) FROM ci_core.users;

-- Verify a specific user
SELECT * FROM ci_core.users WHERE email = 'jsmith@example.com';

-- Check for orphaned answers (answers without users)
SELECT COUNT(*) FROM answers a
LEFT JOIN ci_core.users u ON a.user_id = u.id
WHERE u.id IS NULL;

-- Verify thread messages
SELECT t.name, COUNT(m.id) as message_count
FROM threads t
LEFT JOIN messages m ON m.thread_id = t.id
GROUP BY t.id, t.name;
```

## Troubleshooting

### Issue: "User already exists, skipping"

**Cause:** A user with that `id` is already in the database.

**Solutions:**
- If this is expected (re-running seed), this is normal behavior
- If you want to replace the user, delete them first or use a different `id`
- To clear all data: `make dbclear` (⚠️ destroys all data)

### Issue: "Foreign key violation"

**Cause:** A record references an `id` that doesn't exist yet.

**Solutions:**
- Ensure data is imported in the correct order (see main README)
- Verify the referenced `id` exists in the parent table
- Check for typos in UUID values

### Issue: "Invalid UUID format"

**Cause:** The `id` field contains an invalid UUID.

**Solutions:**
- Verify UUIDs are in format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- Check for extra spaces or special characters
- Ensure lowercase or uppercase is consistent (though both should work)

### Issue: "Date parsing error"

**Cause:** Date is not in ISO 8601 format.

**Solutions:**
- Convert dates to format: `YYYY-MM-DDTHH:MM:SSZ`
- Include timezone offset or `Z` for UTC
- Don't use localized date formats (MM/DD/YYYY, DD-MM-YYYY, etc.)

### Issue: "Column does not exist"

**Cause:** CSV header doesn't match expected column names.

**Solutions:**
- Check the data source specification for exact column names
- Column names are case-sensitive
- Ensure no extra spaces in header row

### Issue: "Failed to connect to database"

**Cause:** Database is not running or connection settings are wrong.

**Solutions:**
- Ensure Docker is running: `docker ps`
- Start infrastructure: `make infra`
- Verify `.env` has correct database credentials
- Check PostgreSQL logs: `docker compose logs postgres`

## Migration Utilities

### Schema Migration Scripts

When the database schema changes, migration scripts help update existing seed data:

**Example: Migrating events to new schema**

```bash
cd backend/apps/api
yarn run exec -- scripts/seed-database/run-migration.ts
```

Available migrations in `backend/apps/api/scripts/seed-database/`:
- `migrate-events.ts` - Updates event data to new schema
- `migrate-locations-to-position.ts` - Converts location format
- `migrate-places-to-entities.ts` - Updates place references
- `migrate-things-to-inventory.ts` - Migrates inventory items

### Custom Migration Scripts

To create a custom migration:

1. Create a new file: `migrate-{description}.ts`
2. Follow the pattern from existing migration scripts
3. Use transactions for data integrity
4. Add to `run-migration.ts` if it should run automatically

Example migration structure:

```typescript
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

const logger = new Logger('migrate-custom');

export async function migrateCustomData(db: DataSource) {
  await db.transaction(async (manager) => {
    // Your migration logic here
    const records = await manager.query('SELECT * FROM old_table');
    
    for (const record of records) {
      await manager.query(
        'INSERT INTO new_table (field1, field2) VALUES ($1, $2)',
        [record.old_field1, record.old_field2]
      );
    }
    
    logger.log(`Migrated ${records.length} records`);
  });
}
```

## Best Practices

1. **Always backup** your database before importing: `pg_dump` or use Docker volume snapshots
2. **Test with small datasets** first before importing thousands of records
3. **Use transactions** - the seed scripts wrap imports in transactions for rollback on error
4. **Validate data** before import using scripts or tools
5. **Document your mappings** - keep notes on how source fields map to CI-Server fields
6. **Version your seed data** - use git to track changes to CSV files (but exclude PII)
7. **Use meaningful IDs** - UUIDv7 provides time-ordering which helps with debugging

## Next Steps

- Review [data source specifications](./data-sources/) for detailed field information
- Examine example CSV files in `backend/apps/api/scripts/seed-database/`
- Set up your data pipeline to export to CSV format
- Start with a small test import before processing your full dataset

## Additional Resources

- [PostgreSQL COPY documentation](https://www.postgresql.org/docs/current/sql-copy.html) - For very large imports
- [CSV RFC 4180](https://tools.ietf.org/html/rfc4180) - CSV format specification
- [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) - Date format standard
- [UUID v7 Draft](https://datatracker.ietf.org/doc/html/draft-peabody-dispatch-new-uuid-format) - Time-ordered UUIDs
