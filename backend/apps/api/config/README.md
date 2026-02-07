# JSON Configuration Examples

This directory contains example JSON configuration files for the ETL system's declarative provider integrations.

## Directory Structure

```
config/
├── providers/examples/          # Provider configurations
│   ├── google.provider.json
│   ├── microsoft.provider.json
│   └── facebook.provider.json
├── api-specs/examples/          # API specifications
│   ├── google-apis-v1.spec.json
│   ├── microsoft-graph-v1.spec.json
│   └── facebook-graph-v18.spec.json
└── transform-maps/examples/     # Transform maps
    ├── google-gmail.transform.json
    ├── google-calendar.transform.json
    ├── google-drive.transform.json
    └── ...more transforms
```

## What's Included

### Provider Configurations (3 examples)
- **Google** - Gmail, Calendar, Drive, YouTube, Contacts
- **Microsoft** - Outlook Mail, Calendar, OneDrive
- **Facebook** - Posts, Photos, Videos, Friends

### API Specifications (3 examples)
- **Google APIs v1** - 8 endpoints (Gmail, Calendar, Drive, YouTube, Contacts)
- **Microsoft Graph v1** - 6 endpoints (Outlook, Calendar, OneDrive)
- **Facebook Graph v18** - 4 endpoints (Posts, Photos, Videos, Friends)

### Transform Maps (3 examples for Google)
- **Gmail → Communication** - Email message transformation
- **Calendar → Event** - Calendar event transformation
- **Drive → Content** - File metadata transformation

## Usage

These are **example files** for reference and learning. To use them in your system:

1. **Review and customize** - Modify IDs, scopes, endpoints to match your needs
2. **Validate** - Ensure JSON syntax is correct
3. **Load into database** - Insert via migration or seed script
4. **Test** - Verify with mock data before using real APIs

## Documentation

For complete documentation on the JSON configuration format:
- [JSON Configuration Reference Guide](../../../docs/json-configuration-reference.md)
- [ETL System Design](../../../docs/etl-system-design.md)
- [Provider Integration Roadmap](../../../docs/provider-integration-roadmap.md)

## Key Concepts

### Provider Config
Defines **what** to sync:
- Available data sources (Gmail, Calendar, etc.)
- OAuth scopes required
- Default settings
- UI branding

### API Spec
Defines **how** to fetch:
- API endpoints and methods
- Query parameters (static, dynamic, template)
- Pagination configuration
- Rate limits

### Transform Map
Defines **how** to normalize:
- Field mappings (direct, nested, computed, template)
- Type transformations (date, number, boolean)
- Custom transformer functions
- Default values

## Template Syntax

The configuration supports template variables:

```json
{
  "template": "{{ syncState.gmail.nextPageToken }}"
}
```

Available contexts:
- `{{ connection.field }}` - Connection data
- `{{ syncState.field }}` - Sync state tracking
- `{{ parameters.field }}` - Dynamic parameters

## Custom Transformers

Built-in transformer functions available in transform maps:

**Email:**
- `extractEmailBody` - Parse email body from MIME
- `extractEmailRecipients` - Extract To/CC/BCC
- `parseEmailHeaders` - Structure headers
- `extractEmailSender` - Get From address

**Calendar:**
- `parseRecurrenceRule` - Parse RRULE
- `extractAttendees` - Normalize attendees
- `parseCalendarDateTime` - Handle dates
- `extractEventDuration` - Calculate duration

**File:**
- `extractFileMetadata` - Parse file data
- `generateThumbnailUrl` - Create thumbnails
- `formatFileSize` - Human-readable sizes
- `categorizeFile` - Determine file type
- `extractFileExtension` - Get extension

## Adding New Providers

1. Copy an existing provider config as a template
2. Update provider details (name, description, branding)
3. Define data sources and OAuth scopes
4. Create corresponding API spec with endpoints
5. Create transform maps for each data type
6. Test with mock data
7. Load into database

## Validation

Before deploying:
- ✅ Valid JSON syntax
- ✅ All referenced IDs exist (apiSpecId, transformMap)
- ✅ OAuth scopes are correct
- ✅ Endpoint paths are valid
- ✅ Transform map fields match source data
- ✅ Required fields are present

## Next Steps

- Create additional transform maps for Microsoft and Facebook
- Add more providers (Spotify, GitHub, Slack, etc.)
- Implement data persistence for transformed data
- Set up automated testing with mock APIs

---

**Note**: These examples are for reference only. Always review and test configurations before using in production.
