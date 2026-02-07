# ETL Configuration Scripts

This directory contains scripts for managing ETL configuration data.

## Available Scripts

### seed-configurations.ts

Seeds provider configurations, API specifications, and transform maps from JSON files into the database.

**Usage:**

```bash
# Seed all configurations
yarn seed:etl-config

# Seed specific provider only
yarn seed:etl-config --provider=google

# Dry run (preview changes without applying)
yarn seed:etl-config --dry-run
```

**What it does:**
1. Reads JSON configuration files from `backend/apps/api/config/`
2. Inserts or updates records in the database
3. Provides detailed statistics on operations performed

**Output:**
- ✅ Success messages for each configuration loaded
- ❌ Error messages for any failures
- 📊 Summary with insert/update/skip counts

### validate-configurations.ts

Validates all JSON configuration files for correctness and consistency.

**Usage:**

```bash
# Validate all configurations
yarn validate:etl-config

# Validate specific provider
yarn validate:etl-config --provider=google

# Verbose output
yarn validate:etl-config --verbose
```

**Checks performed:**
- JSON syntax validation
- Required fields presence
- ID reference consistency
- Transform map source/target type matching
- OAuth configuration completeness

## Configuration Files

Configuration files are located in:
- `backend/apps/api/config/providers/*.provider.json`
- `backend/apps/api/config/api-specs/*.spec.json`
- `backend/apps/api/config/transform-maps/*.transform.json`

## Database Tables

Configurations are stored in:
- `ci.etl_provider_configs` - Provider metadata and sources
- `ci.etl_api_specs` - API endpoint specifications
- `ci.etl_transform_maps` - Data transformation rules

## Environment Variables

Required for database connection:
- `POSTGRES_HOST` - Database host (default: localhost)
- `POSTGRES_PORT` - Database port (default: 5432)
- `POSTGRES_USER` - Database user (default: postgres)
- `POSTGRES_PASSWORD` - Database password
- `POSTGRES_DB` - Database name (default: ci_server)

## Troubleshooting

**Connection errors:**
- Verify database is running
- Check environment variables
- Ensure migrations have been run

**Validation errors:**
- Check JSON syntax
- Verify all required fields
- Ensure IDs match between configs

**Seed errors:**
- Run migrations first: `yarn migrate`
- Check file permissions
- Verify JSON file paths
