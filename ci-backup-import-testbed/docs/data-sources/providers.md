# Providers Data Source

External service providers that can be connected to user accounts (e.g., Google, Microsoft).

## CSV File Format

**File name:** `providers.csv`

**Import order:** 1st (must be imported before all other data)

**Location:** `backend/apps/api/scripts/seed-database/providers-data/providers.csv`

## Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | UUID | Unique provider identifier | `0198779b-182c-716e-9275-b81d99a47fdb` |
| `name` | String | Provider name | `Google` |

## Field Details

### `id` - Provider ID
- **Type:** UUID
- **Required:** Yes
- **Unique:** Yes
- **Notes:** Referenced by user connections

### `name` - Provider Name
- **Type:** String
- **Required:** Yes
- **Description:** Display name of the service provider
- **Common Values:**
  - `Google`
  - `Microsoft`
  - `Apple`
  - `Facebook`
  - `GitHub`

## Example CSV

```csv
id,name
0198779b-182c-716e-9275-b81d99a47fdb,Google
0198779b-3c33-73da-84e5-82e0df145260,Microsoft
0198779b-4d44-84eb-95f6-93f1e0256371,Apple
```

## Database Schema

```sql
CREATE TABLE providers (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Usage

Providers enable OAuth connections and external service integrations. They must exist before:
- User connections can be created
- OAuth flows can be initiated
- External data can be imported

## Standard Providers

It's recommended to import these standard providers:

- **Google** - Gmail, Calendar, Drive integration
- **Microsoft** - Outlook, OneDrive, Office 365
- **Apple** - iCloud, Apple services

## Next Steps

1. Import providers first (before any other data)
2. Ensure standard provider IDs are consistent across environments
3. Reference provider IDs when setting up OAuth configurations
