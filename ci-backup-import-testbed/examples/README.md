# Example CSV Files

This directory contains sample CSV files demonstrating the correct format for importing data into CI-Server.

## Files

- **[providers.csv](./providers.csv)** - External service providers (Google, Microsoft, Apple)
- **[users.csv](./users.csv)** - User account data for Jane Doe and Bob Smith
- **[questions.csv](./questions.csv)** - Intelligence questions across different categories
- **[answers.csv](./answers.csv)** - Sample user answers to questions
- **[threads.csv](./threads.csv)** - Conversation threads
- **[messages.csv](./messages.csv)** - Messages within threads (includes multi-line example)
- **[actions.csv](./actions.csv)** - Recommended actions with tags

## Usage

These examples demonstrate:

✅ **Proper UUID format** - All IDs use valid UUIDv7 format  
✅ **ISO 8601 dates** - Timestamps include timezone (`Z` for UTC)  
✅ **Foreign key references** - IDs properly link between tables  
✅ **Field order** - Columns in the documented order  
✅ **Multi-line text** - Messages.csv shows how to handle paragraph breaks  
✅ **Array fields** - Actions.csv shows tag array format `['Tag1', 'Tag2']`  
✅ **Empty fields** - Questions.csv shows empty subcategory handling  

## Quick Test Import

To test these examples:

1. Copy these CSV files to a test directory:
   ```bash
   mkdir -p backend/apps/api/scripts/seed-database/example-data
   cp ci-backup-import-testbed/examples/*.csv backend/apps/api/scripts/seed-database/example-data/
   ```

2. Update `main.ts` to use the example data directory:
   ```typescript
   const dataDir = path.resolve(__dirname);
   await seedProviders(db, path.resolve(dataDir, './providers-data/providers.csv'));
   await seedUsers(db, path.resolve(dataDir, './example-data/users.csv'));
   await seedQuestions(db, path.resolve(dataDir, './example-data/questions.csv'));
   // ... etc
   ```

3. Run the import:
   ```bash
   make seed
   ```

## Data Relationships

The example data demonstrates proper referential integrity:

```
Providers (providers.csv)
    └─ (referenced by user connections)

Users (users.csv)
    ├─ Jane Doe: 01987b9c-4f5g-0h9i-2d3e-f4g5h6i7d8e9
    └─ Bob Smith: 01987b9c-5g6h-1i0j-3e4f-g5h6i7j8e9f0

Questions (questions.csv)
    ├─ Core Identity question (for Jane)
    ├─ Daily Habits question (for Jane)
    └─ Relationships question (for Jane)

Answers (answers.csv)
    ├─ Jane's answer to Core Identity question
    └─ Jane's answer to Daily Habits question

Threads (threads.csv)
    ├─ Weekend planning (Jane's thread)
    └─ Meal prep ideas (Jane's thread)

Messages (messages.csv)
    └─ Conversation about weekend planning (3 messages)

Actions (actions.csv)
    ├─ Hiking action (linked to weekend planning thread)
    └─ Meal prep action (linked to meal prep thread)
```

## User Credentials

The example users will use the default password from `AUTH_DEFAULT_USER_PASSWORD`.

To log in as Jane Doe:
```
Email: jdoe@example.com
Password: [from environment variable]
```

To log in as Bob Smith:
```
Email: bsmith@example.com
Password: [from environment variable]
```

## Customization

To create your own test data:

1. **Start with these templates** - Copy and modify the example files
2. **Generate new UUIDs** - Use `uuidv7()` from the `uuid` package
3. **Update references** - Ensure user_id, question_id, thread_id match
4. **Maintain order** - Import providers → users → questions → answers → threads → actions → messages

## Validation

Before importing your custom data:

1. ✅ All UUIDs are valid format
2. ✅ All dates are ISO 8601 with timezone
3. ✅ Foreign keys reference existing records
4. ✅ Required fields are populated
5. ✅ Arrays use Python list format `['item1', 'item2']`
6. ✅ Multi-line text is properly quoted

## Notes

- **UUIDs are fictitious** - These UUIDs are for example purposes only
- **Data is minimal** - Real imports would have many more records
- **Timestamps are consistent** - All examples use 2025-06-01 for simplicity
- **One user focus** - Most data references Jane Doe for clarity

For more details, see the [main documentation](../README.md).
