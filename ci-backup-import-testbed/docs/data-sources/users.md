# Users Data Source

User account data for authentication and profile information.

## CSV File Format

**File name:** `{prefix}-users.csv` (e.g., `js1-users.csv`)

**Import order:** 2nd (after Providers)

## Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | UUID | Unique user identifier (use UUIDv7) | `b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b` |
| `first_name` | String | User's first name | `John` |
| `last_name` | String | User's last name | `Smith` |
| `email` | Email | User's email address (must be unique) | `jsmith@example.com` |
| `created_at` | ISO 8601 Date | Account creation timestamp | `2025-05-20T00:00:00Z` |
| `updated_at` | ISO 8601 Date | Last update timestamp | `2025-05-20T00:00:00Z` |

## Field Details

### `id` - User ID
- **Type:** UUID (v7 recommended)
- **Required:** Yes
- **Unique:** Yes
- **Description:** Permanent unique identifier for the user
- **Notes:** 
  - Will be referenced by other tables (answers, threads, messages, etc.)
  - Must be a valid UUID format
  - Use UUIDv7 for time-ordered IDs: `import { v7 as uuidv7 } from 'uuid'`

### `first_name` - First Name
- **Type:** String
- **Required:** Yes
- **Max Length:** 255 characters
- **Description:** User's given name
- **Example:** `John`, `Jane`, `María`

### `last_name` - Last Name
- **Type:** String
- **Required:** Yes
- **Max Length:** 255 characters
- **Description:** User's family name
- **Example:** `Smith`, `Doe`, `García`
- **Notes:** Full name will be stored as `{first_name} {last_name}`

### `email` - Email Address
- **Type:** Email
- **Required:** Yes
- **Unique:** Yes
- **Description:** User's email address for authentication
- **Validation:** Must be valid email format
- **Example:** `jsmith@example.com`
- **Notes:** 
  - Username is auto-generated from email prefix
  - Used for login authentication

### `created_at` - Creation Timestamp
- **Type:** ISO 8601 DateTime
- **Required:** Yes
- **Description:** When the user account was created
- **Format:** `YYYY-MM-DDTHH:MM:SSZ` or with timezone offset
- **Example:** 
  - `2025-05-20T00:00:00Z` (UTC)
  - `2025-05-20T14:30:00-07:00` (PDT)

### `updated_at` - Update Timestamp
- **Type:** ISO 8601 DateTime
- **Required:** Yes
- **Description:** Last time the user record was modified
- **Format:** `YYYY-MM-DDTHH:MM:SSZ` or with timezone offset
- **Example:** `2025-05-20T00:00:00Z`
- **Notes:** Usually the same as `created_at` for initial import

## Auto-Generated Fields

The following fields are automatically generated during import:

| Field | Value | Description |
|-------|-------|-------------|
| `name` | `{first_name} {last_name}` | Full display name |
| `username` | Email prefix | Generated from email before @ |
| `password` | Hashed | From `AUTH_DEFAULT_USER_PASSWORD` env var |
| `password_hash` | Hashed | Duplicate for compatibility |
| `role` | `user` | User role level |
| `is_active` | `true` | Account active status |
| `is_verified` | `true` | Email verified status |
| `timezone` | `UTC` | Default timezone |
| `language` | `en` | Default language |
| `login_count` | `0` | Number of logins |
| `failed_login_attempts` | `0` | Failed login attempts |
| `settings` | `{}` | Empty JSON object |
| `api_keys` | `{}` | Empty JSON object |
| `permissions` | `{}` | Empty JSON object |
| `display_preferences` | `{}` | Empty JSON object |
| `onboarded` | `true` | Seeded users are pre-onboarded |

## Example CSV

```csv
id,first_name,last_name,email,created_at,updated_at
b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,John,Smith,jsmith@example.com,2025-05-20T00:00:00Z,2025-05-20T00:00:00Z
c4c9d8f3-2d3e-5f6g-9b7c-0d1e2f3g4h5i,Jane,Doe,jdoe@example.com,2025-05-21T08:30:00Z,2025-05-21T08:30:00Z
```

## Password Configuration

Users created via CSV import will all share the same default password, configured via environment variable:

```bash
# In your .env file
AUTH_DEFAULT_USER_PASSWORD="]60.a6{CJ}lB*rHAp;w;"
```

**Security Notes:**
- Password is hashed using bcrypt with configurable salt rounds
- Users should be prompted to change password on first login
- Never commit actual user passwords to CSV files
- For production, consider requiring password reset tokens

## Import Behavior

### Duplicate Handling
If a user with the same `id` already exists:
- The existing user is kept (not overwritten)
- A log message indicates the skip: `User {email} already exists, skipping...`
- Import continues with next record

### Error Conditions

**Import will fail if:**
- Email is already in use by another user (unique constraint)
- `id` is not a valid UUID format
- Required fields are missing
- Date format is invalid
- `AUTH_DEFAULT_USER_PASSWORD` environment variable is not set

## Example Code

### Generate User CSV with Node.js

```javascript
import { v7 as uuidv7 } from 'uuid';
import { stringify } from 'csv-stringify/sync';
import fs from 'fs';

const users = [
  {
    id: uuidv7(),
    first_name: 'John',
    last_name: 'Smith',
    email: 'jsmith@example.com',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
];

const csv = stringify(users, { header: true });
fs.writeFileSync('users.csv', csv);
```

### Validate User CSV

```javascript
import { parse } from 'csv-parse/sync';
import fs from 'fs';

const content = fs.readFileSync('users.csv', 'utf8');
const records = parse(content, { columns: true });

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

records.forEach((record, index) => {
  const line = index + 2; // +2 for header and 1-based indexing
  
  if (!uuidPattern.test(record.id)) {
    console.error(`Line ${line}: Invalid UUID: ${record.id}`);
  }
  
  if (!emailPattern.test(record.email)) {
    console.error(`Line ${line}: Invalid email: ${record.email}`);
  }
  
  if (!record.first_name || !record.last_name) {
    console.error(`Line ${line}: Missing name fields`);
  }
});
```

## Database Schema

Users are stored in the `ci_core.users` table with the following structure:

```sql
CREATE TABLE ci_core.users (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  username VARCHAR(255),
  password_hash VARCHAR(255),
  role VARCHAR(50) DEFAULT 'user',
  is_active BOOLEAN DEFAULT true,
  is_verified BOOLEAN DEFAULT false,
  timezone VARCHAR(50) DEFAULT 'UTC',
  language VARCHAR(10) DEFAULT 'en',
  login_count INTEGER DEFAULT 0,
  failed_login_attempts INTEGER DEFAULT 0,
  settings JSONB DEFAULT '{}',
  api_keys JSONB DEFAULT '{}',
  permissions JSONB DEFAULT '{}',
  display_preferences JSONB DEFAULT '{}',
  onboarded BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE
);
```

## Related Data Types

After importing users, you can import:
- [Answers](./answers.md) - User answers to questions
- [Threads](./threads.md) - User conversation threads
- [Actions](./actions.md) - User-specific recommended actions
- [Messages](./messages.md) - User messages in threads

## Troubleshooting

### Issue: "Email already in use"

**Solution:** Each user must have a unique email address. Check for duplicates in your CSV.

### Issue: "Password not set"

**Solution:** Ensure `AUTH_DEFAULT_USER_PASSWORD` is set in your `.env` file.

### Issue: "Invalid UUID"

**Solution:** Use proper UUID format. Generate with `uuidv7()` from the `uuid` package.

## Next Steps

1. Prepare your user data in CSV format
2. Set `AUTH_DEFAULT_USER_PASSWORD` environment variable
3. Place CSV file in `backend/apps/api/scripts/seed-database/{prefix}-data/`
4. Run `make seed` or the seed script directly
5. Verify users were created with a database query or login test
