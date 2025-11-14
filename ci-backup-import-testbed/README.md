# CI-Server Data Import Testbed

This directory contains documentation and examples for importing data into the CI-Server database.

## Overview

The CI-Server supports importing data from various sources through a CSV-based seeding system. This allows you to:

- Bootstrap a new database with initial data
- Import existing user data from other systems
- Create test datasets for development and QA
- Migrate data from legacy systems

## Quick Start

1. Prepare your CSV files according to the format specifications in `docs/data-sources/`
2. Place your CSV files in the appropriate data directory (e.g., `backend/apps/api/scripts/seed-database/js1-data/`)
3. Run the seed command:
   ```bash
   make seed
   ```

## Documentation Structure

- **[docs/README.md](./docs/README.md)** - Detailed import process documentation
- **[docs/data-sources/](./docs/data-sources/)** - Format specifications for each data source type
  - [Users](./docs/data-sources/users.md) - User account data
  - [Questions](./docs/data-sources/questions.md) - Intelligence questions
  - [Answers](./docs/data-sources/answers.md) - User answers to questions
  - [Threads](./docs/data-sources/threads.md) - Conversation threads
  - [Messages](./docs/data-sources/messages.md) - Thread messages
  - [Actions](./docs/data-sources/actions.md) - Recommended actions
  - [Providers](./docs/data-sources/providers.md) - External service providers
  - [Events](./docs/data-sources/events.md) - Calendar events (optional)
  - [People](./docs/data-sources/people.md) - Contacts and relationships (optional)
  - [Content](./docs/data-sources/content.md) - User-generated content (optional)
  - [Things](./docs/data-sources/things.md) - Inventory items (optional)
  - [Places](./docs/data-sources/places.md) - Locations (optional)
- **[examples/](./examples/)** - Sample CSV files demonstrating correct format

## Data Import Order

The seeding process imports data in a specific order to maintain referential integrity:

1. **Providers** - External service providers must exist first
2. **Users** - User accounts are created next
3. **Questions** - Intelligence questions are loaded
4. **Answers** - User answers to questions (requires Users)
5. **Threads** - Conversation threads (requires Users)
6. **Actions** - Recommended actions (requires Users and Threads)
7. **Messages** - Thread messages (requires Users and Threads)
8. *(Optional)* Events, People, Content, Things, Places

## CSV File Requirements

All CSV files must:

- Include a header row with column names
- Use UTF-8 encoding
- Follow the field specifications for each data type
- Use ISO 8601 format for dates (e.g., `2025-05-20T00:00:00Z`)
- Use valid UUIDs for `id` fields
- Maintain referential integrity (e.g., `user_id` must match an existing user)

## Examples

Example CSV files are available in:
- **[examples/](./examples/)** - Complete sample dataset with proper formatting
- `backend/apps/api/scripts/seed-database/js1-data/` - John Smith example data
- `backend/apps/api/scripts/seed-database/intelligence-data/` - Intelligence questions
- `backend/apps/api/scripts/seed-database/providers-data/` - Provider configuration

See [examples/README.md](./examples/README.md) for details on using the sample data.

## Common Issues

### Import Fails Due to Existing Data

The seeding process is idempotent for most data types. If a record with the same `id` already exists, it will be skipped.

### Invalid UUID Format

Ensure all `id` fields contain valid UUIDs. You can generate UUIDs using:
- Online tools like [uuidgenerator.net](https://www.uuidgenerator.net/)
- Command line: `uuidgen` (macOS/Linux)
- Node.js: `require('uuid').v7()` (recommended - time-ordered)

### Date Format Errors

All dates must be in ISO 8601 format with timezone:
- ✅ Correct: `2025-05-20T00:00:00Z`
- ✅ Correct: `2025-05-20T14:30:00-07:00`
- ❌ Incorrect: `05/20/2025`
- ❌ Incorrect: `2025-05-20`

### Referential Integrity Errors

Ensure that:
- `user_id` references exist in the users CSV
- `thread_id` references exist in the threads CSV
- Foreign keys are imported before records that reference them

## Security Considerations

⚠️ **Important Security Notes:**

- **Never commit sensitive data** to version control
- User passwords are hashed using bcrypt with configurable salt rounds
- Default password is set via `AUTH_DEFAULT_USER_PASSWORD` environment variable
- CSV files may contain PII - handle with care and follow privacy regulations
- Use `.gitignore` to exclude data directories with real user information

## Advanced Topics

### Custom Data Directories

You can organize your CSV files in custom directories. Update the paths in `backend/apps/api/scripts/seed-database/main.ts`:

```typescript
await seedUsers(db, path.resolve(dataDir, './custom-data/users.csv'));
```

### Extending the Seed Script

To add new data types:

1. Create a CSV file with your data
2. Create a seed function in `backend/apps/api/scripts/seed-database/seed-{type}.ts`
3. Import and call the function in `main.ts`
4. Follow the existing patterns for transaction handling and error logging

### Bulk Operations

For large datasets (>10,000 records), consider:
- Batching inserts within transactions
- Using PostgreSQL COPY commands for faster imports
- Temporarily disabling indexes during import

## Support

For questions or issues:
- Check the [detailed documentation](./docs/README.md)
- Review the [data source specifications](./docs/data-sources/)
- Examine the example CSV files
- Contact the development team

## Related Documentation

- [Database Architecture](../docs/architecture/Database.md)
- [Backend API README](../backend/apps/api/README.md)
- [Repository README](../README.md)
