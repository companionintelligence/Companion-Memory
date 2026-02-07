# JSON Configuration Reference Guide

**ETL System Configuration Documentation**

This guide provides comprehensive documentation for all JSON configuration files used in the ETL system. The ETL system uses a declarative, configuration-driven approach where provider integrations are defined via JSON rather than code.

---

## Table of Contents

1. [Overview](#overview)
2. [Provider Configuration](#provider-configuration)
3. [API Specification](#api-specification)
4. [Transform Map](#transform-map)
5. [Complete Examples](#complete-examples)
6. [Validation](#validation)
7. [Best Practices](#best-practices)

---

## Overview

The ETL system uses three types of JSON configurations:

| Configuration Type | Purpose | Defines |
|-------------------|---------|---------|
| **Provider Config** | What to sync | Data sources, OAuth settings, provider branding |
| **API Spec** | How to fetch | Endpoints, parameters, pagination, rate limits |
| **Transform Map** | How to normalize | Field mappings, type transformations, data normalization |

### Data Flow

```
Provider Config → API Spec → API Request → Raw Data → Transform Map → Normalized Data
```

---

## Provider Configuration

Provider configurations define **what** data sources are available from an API provider and their default settings.

### Schema

```typescript
{
  "id": string,                      // UUID - Unique provider identifier
  "name": string,                    // Display name (e.g., "Google", "Microsoft")
  "description": string | null,      // Human-readable description
  "logoUrl": string | null,          // URL to provider logo image
  "theme": {                         // UI branding colors
    "backgroundColor": string | null,
    "borderColor": string | null
  },
  "sources": ProviderSource[],       // Available data sources
  "auth": OAuthConfig,               // OAuth configuration
  "apiSpecId": string,               // Reference to API specification
  "enabled": boolean                 // Whether provider is active
}
```

### ProviderSource

Each source represents a distinct data stream (e.g., Gmail, Calendar, Drive).

```typescript
{
  "name": string,                    // Source name (e.g., "Gmail", "Calendar")
  "description": string,             // Human-readable description
  "enabledByDefault": boolean,       // Auto-enable for new connections
  "endpoints": string[],             // API endpoints to call for this source
  "scopes": string[],                // OAuth scopes required
  "transformMap": string             // Transform map ID to use
}
```

### OAuthConfig

```typescript
{
  "type": "oauth1" | "oauth2" | "api_key",
  "authorizationUrl": string,        // OAuth authorization endpoint
  "tokenUrl": string,                // Token exchange endpoint
  "scopes": string[],                // Default OAuth scopes
  "extraParams": {                   // Additional OAuth parameters (optional)
    [key: string]: string
  }
}
```

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | UUID string | Yes | Unique identifier for this provider. Should be a valid UUID. |
| `name` | string | Yes | Display name shown to users (e.g., "Google", "Microsoft 365"). |
| `description` | string \| null | No | Brief description of what this provider offers. |
| `logoUrl` | string \| null | No | Path or URL to provider logo image for UI display. |
| `theme.backgroundColor` | string \| null | No | Hex color for provider's background in UI (e.g., "#4285f4"). |
| `theme.borderColor` | string \| null | No | Hex color for provider's border in UI. |
| `sources` | array | Yes | List of data sources available from this provider. Must have at least one. |
| `auth` | object | Yes | OAuth configuration for authenticating with this provider. |
| `apiSpecId` | string | Yes | ID of the API specification that defines endpoints for this provider. |
| `enabled` | boolean | Yes | Whether this provider is active and can be used. |

### Example: Google Provider Config

```json
{
  "id": "0198779b-182c-716e-9275-b81d99a47fdb",
  "name": "Google",
  "description": "Connect to Google Workspace for Gmail, Calendar, Drive, and more.",
  "logoUrl": "/branding/google/logo.svg",
  "theme": {
    "backgroundColor": "#4285f4",
    "borderColor": "#1967d2"
  },
  "sources": [
    {
      "name": "Gmail",
      "description": "Sync email messages, labels, and threads.",
      "enabledByDefault": true,
      "endpoints": ["GmailMessages", "GmailLabels"],
      "scopes": [
        "https://www.googleapis.com/auth/gmail.readonly"
      ],
      "transformMap": "google_gmail_to_communication"
    },
    {
      "name": "Calendar",
      "description": "Sync calendar events and scheduling information.",
      "enabledByDefault": true,
      "endpoints": ["CalendarEvents", "CalendarList"],
      "scopes": [
        "https://www.googleapis.com/auth/calendar.readonly"
      ],
      "transformMap": "google_calendar_to_event"
    },
    {
      "name": "Drive",
      "description": "Sync files, folders, and document changes.",
      "enabledByDefault": false,
      "endpoints": ["DriveFiles", "DriveChanges"],
      "scopes": [
        "https://www.googleapis.com/auth/drive.readonly"
      ],
      "transformMap": "google_drive_to_content"
    }
  ],
  "auth": {
    "type": "oauth2",
    "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth",
    "tokenUrl": "https://oauth2.googleapis.com/token",
    "scopes": [],
    "extraParams": {
      "access_type": "offline",
      "prompt": "consent"
    }
  },
  "apiSpecId": "google_apis_v1",
  "enabled": true
}
```

---

## API Specification

API specifications define **how** to fetch data from provider APIs, including endpoints, parameters, pagination, and rate limits.

### Schema

```typescript
{
  "id": string,                      // Unique spec identifier
  "name": string,                    // Spec name (e.g., "Google APIs v1")
  "baseUrl": string,                 // Base URL for all endpoints
  "version": string,                 // API version
  "meta": ApiMetadata,               // Metadata configuration
  "endpoints": {                     // Endpoint specifications
    [endpointName: string]: EndpointSpec
  },
  "globalRateLimit": RateLimitConfig | undefined  // Global rate limits
}
```

### ApiMetadata

```typescript
{
  "uniquenessField": string,         // Field for unique user identifier (e.g., "id", "email")
  "defaultNameField": string,        // Field for display name (e.g., "name", "email")
  "profileEndpoint": string          // Endpoint to fetch user profile
}
```

### EndpointSpec

```typescript
{
  "name": string,                    // Endpoint identifier
  "method": "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  "path": string,                    // URL path (may include path params)
  "scopes": string[],                // Required OAuth scopes (optional)
  "headers": {                       // Static headers to include (optional)
    [key: string]: string
  },
  "queryParams": {                   // Query parameters (optional)
    [paramName: string]: ParamSpec
  },
  "bodyTemplate": string,            // Request body template for POST/PUT (optional)
  "responseType": "single" | "collection",  // Response type
  "dataPath": string,                // JSON path to data in response (optional)
  "pagination": PaginationConfig,    // Pagination configuration (optional)
  "rateLimit": RateLimitConfig,      // Endpoint-specific rate limit (optional)
  "timeout": number                  // Request timeout in ms (optional)
}
```

### ParamSpec

Defines how to resolve parameter values.

```typescript
{
  "type": "static" | "dynamic" | "template",
  "value": string | number | boolean,     // For "static" type
  "source": string,                        // For "dynamic" type (e.g., "syncState.lastId")
  "template": string,                      // For "template" type (e.g., "{{ syncState.token }}")
  "required": boolean,                     // Whether parameter is required (optional)
  "default": any                           // Default value if not provided (optional)
}
```

**Parameter Types:**
- **static**: Fixed value that never changes
- **dynamic**: Value extracted from context (connection, syncState, etc.)
- **template**: Value generated from template with `{{ }}` placeholders

### PaginationConfig

```typescript
{
  "type": "cursor" | "offset" | "token",
  "nextTokenField": string,          // Field in response with next page token (optional)
  "tokenParam": string,              // Query param name for page token (optional)
  "limitParam": string,              // Query param name for page size (optional)
  "defaultLimit": number,            // Default page size (optional)
  "maxLimit": number                 // Maximum page size (optional)
}
```

### RateLimitConfig

```typescript
{
  "requestsPerSecond": number,       // Requests per second limit (optional)
  "requestsPerMinute": number,       // Requests per minute limit (optional)
  "requestsPerHour": number,         // Requests per hour limit (optional)
  "requestsPerDay": number           // Requests per day limit (optional)
}
```

### Example: Google API Spec

```json
{
  "id": "google_apis_v1",
  "name": "Google APIs v1",
  "baseUrl": "https://www.googleapis.com",
  "version": "v1",
  "meta": {
    "uniquenessField": "id",
    "defaultNameField": "email",
    "profileEndpoint": "oauth2/v2/userinfo"
  },
  "endpoints": {
    "GmailMessages": {
      "name": "GmailMessages",
      "method": "GET",
      "path": "/gmail/v1/users/me/messages",
      "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
      "responseType": "collection",
      "dataPath": "messages",
      "queryParams": {
        "maxResults": {
          "type": "static",
          "value": 100
        },
        "pageToken": {
          "type": "template",
          "template": "{{ syncState.gmail.nextPageToken }}",
          "required": false
        },
        "labelIds": {
          "type": "static",
          "value": "INBOX"
        },
        "q": {
          "type": "dynamic",
          "source": "parameters.searchQuery",
          "required": false
        }
      },
      "pagination": {
        "type": "token",
        "nextTokenField": "nextPageToken",
        "tokenParam": "pageToken",
        "limitParam": "maxResults",
        "defaultLimit": 100,
        "maxLimit": 500
      },
      "rateLimit": {
        "requestsPerSecond": 5,
        "requestsPerHour": 10000
      },
      "timeout": 30000
    },
    "CalendarEvents": {
      "name": "CalendarEvents",
      "method": "GET",
      "path": "/calendar/v3/calendars/primary/events",
      "scopes": ["https://www.googleapis.com/auth/calendar.readonly"],
      "responseType": "collection",
      "dataPath": "items",
      "queryParams": {
        "maxResults": {
          "type": "static",
          "value": 250
        },
        "pageToken": {
          "type": "template",
          "template": "{{ syncState.calendar.nextPageToken }}"
        },
        "timeMin": {
          "type": "dynamic",
          "source": "syncState.calendar.lastSyncTime",
          "default": "2020-01-01T00:00:00Z"
        }
      },
      "pagination": {
        "type": "token",
        "nextTokenField": "nextPageToken",
        "tokenParam": "pageToken",
        "defaultLimit": 250
      },
      "rateLimit": {
        "requestsPerSecond": 10
      }
    }
  },
  "globalRateLimit": {
    "requestsPerSecond": 10,
    "requestsPerDay": 100000
  }
}
```

---

## Transform Map

Transform maps define **how** to normalize provider data into the internal schema.

### Schema

```typescript
{
  "id": string,                      // Unique map identifier
  "name": string,                    // Display name
  "description": string,             // Description of transformation
  "sourceType": string,              // Source data type name
  "targetType": string,              // Target data type name
  "fields": {                        // Field mappings
    [targetField: string]: FieldMapping
  },
  "transformers": string[],          // Custom transformer functions used (optional)
  "metadata": TransformMapMetadata,  // Additional metadata (optional)
  "enabled": boolean                 // Whether map is active
}
```

### FieldMapping

Defines how to map a single field from source to target.

```typescript
{
  "type": "direct" | "nested" | "computed" | "template" | "constant",
  "source": string,                  // For "direct" - source field name
  "path": string,                    // For "nested" - JSON path (supports arrays)
  "compute": ComputedField,          // For "computed" - function to execute
  "template": string,                // For "template" - template with {{ }} placeholders
  "constantValue": any,              // For "constant" - fixed value
  "transform": TypeTransform,        // Type transformation (optional)
  "default": any,                    // Default if source is null/undefined (optional)
  "required": boolean,               // Whether field is required (optional)
  "skipNull": boolean                // Skip if value is null (optional)
}
```

**Mapping Types:**

1. **direct**: Simple field-to-field mapping
   ```json
   { "type": "direct", "source": "id" }
   ```

2. **nested**: Extract from nested path (supports `field.subfield`, `array[0]`, `array[key=value]`)
   ```json
   { "type": "nested", "path": "payload.headers[name=Subject].value" }
   ```

3. **computed**: Call a custom transformer function
   ```json
   {
     "type": "computed",
     "compute": {
       "function": "extractEmailBody",
       "inputs": ["payload.parts"],
       "params": { "format": "text" }
     }
   }
   ```

4. **template**: Render a template string
   ```json
   { "type": "template", "template": "{{ sender.name }} <{{ sender.email }}>" }
   ```

5. **constant**: Use a fixed value
   ```json
   { "type": "constant", "constantValue": "email" }
   ```

### ComputedField

```typescript
{
  "function": string,                // Transformer function name
  "inputs": string[],                // Input field paths
  "params": {                        // Additional parameters (optional)
    [key: string]: any
  }
}
```

### TypeTransform

```typescript
{
  "type": "date" | "number" | "boolean" | "json" | "string" | "custom",
  "format": string,                  // For "date" type (e.g., "unix", "unix_ms", "iso8601")
  "customFn": string,                // For "custom" type - transformer function name
  "options": {                       // Additional options (optional)
    [key: string]: any
  }
}
```

**Type Transforms:**
- **date**: Parse dates from Unix timestamps, ISO strings, etc.
  - Formats: `"unix"`, `"unix_ms"`, `"iso8601"`, or auto-detect
- **number**: Convert to number
- **boolean**: Convert to boolean (handles "true", "1", "yes")
- **json**: Parse JSON string
- **string**: Convert to string
- **custom**: Call custom transformer function

### TransformMapMetadata

```typescript
{
  "author": string,                  // Map creator (optional)
  "version": string,                 // Version number (optional)
  "tags": string[],                  // Tags for categorization (optional)
  "notes": string                    // Additional notes (optional)
}
```

### Example: Gmail to Communication Transform Map

```json
{
  "id": "google_gmail_to_communication",
  "name": "Gmail Messages to Communications",
  "description": "Transforms Gmail API message format into internal Communication schema",
  "sourceType": "google_gmail_message",
  "targetType": "communication",
  "fields": {
    "externalId": {
      "type": "direct",
      "source": "id",
      "required": true
    },
    "title": {
      "type": "nested",
      "path": "payload.headers[name=Subject].value",
      "default": "(No Subject)"
    },
    "content": {
      "type": "computed",
      "compute": {
        "function": "extractEmailBody",
        "inputs": ["payload"]
      }
    },
    "sender": {
      "type": "computed",
      "compute": {
        "function": "extractEmailSender",
        "inputs": ["payload.headers"]
      }
    },
    "recipients": {
      "type": "computed",
      "compute": {
        "function": "extractEmailRecipients",
        "inputs": ["payload.headers"]
      }
    },
    "timestamp": {
      "type": "direct",
      "source": "internalDate",
      "transform": {
        "type": "date",
        "format": "unix_ms"
      },
      "required": true
    },
    "type": {
      "type": "constant",
      "constantValue": "email"
    },
    "metadata": {
      "type": "nested",
      "path": "labelIds",
      "transform": {
        "type": "json"
      }
    },
    "isRead": {
      "type": "template",
      "template": "{{ labelIds }}",
      "transform": {
        "type": "custom",
        "customFn": "checkIfUnread"
      }
    }
  },
  "transformers": [
    "extractEmailBody",
    "extractEmailSender",
    "extractEmailRecipients",
    "checkIfUnread"
  ],
  "metadata": {
    "author": "CI-Server",
    "version": "1.0.0",
    "tags": ["google", "gmail", "email", "communication"],
    "notes": "Handles both simple and multipart MIME messages"
  },
  "enabled": true
}
```

---

## Complete Examples

### Google Provider - Full Configuration Set

#### 1. Provider Config
`config/providers/google.provider.json`

```json
{
  "id": "google",
  "name": "Google",
  "description": "Connect Google Workspace for Gmail, Calendar, Drive, YouTube, and Contacts.",
  "logoUrl": "/branding/google/logo.svg",
  "theme": {
    "backgroundColor": "#4285f4",
    "borderColor": "#1967d2"
  },
  "sources": [
    {
      "name": "Gmail",
      "description": "Email messages, labels, and threads",
      "enabledByDefault": true,
      "endpoints": ["GmailMessages"],
      "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
      "transformMap": "google_gmail_to_communication"
    },
    {
      "name": "Calendar",
      "description": "Calendar events and scheduling",
      "enabledByDefault": true,
      "endpoints": ["CalendarEvents"],
      "scopes": ["https://www.googleapis.com/auth/calendar.readonly"],
      "transformMap": "google_calendar_to_event"
    },
    {
      "name": "Drive",
      "description": "Files and folders",
      "enabledByDefault": false,
      "endpoints": ["DriveFiles"],
      "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
      "transformMap": "google_drive_to_content"
    }
  ],
  "auth": {
    "type": "oauth2",
    "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth",
    "tokenUrl": "https://oauth2.googleapis.com/token",
    "scopes": [],
    "extraParams": {
      "access_type": "offline",
      "prompt": "consent"
    }
  },
  "apiSpecId": "google_apis_v1",
  "enabled": true
}
```

#### 2. API Spec
`config/api-specs/google-apis-v1.spec.json`

```json
{
  "id": "google_apis_v1",
  "name": "Google APIs v1",
  "baseUrl": "https://www.googleapis.com",
  "version": "v1",
  "meta": {
    "uniquenessField": "id",
    "defaultNameField": "email",
    "profileEndpoint": "oauth2/v2/userinfo"
  },
  "endpoints": {
    "GmailMessages": {
      "name": "GmailMessages",
      "method": "GET",
      "path": "/gmail/v1/users/me/messages",
      "responseType": "collection",
      "dataPath": "messages",
      "queryParams": {
        "maxResults": { "type": "static", "value": 100 },
        "pageToken": {
          "type": "template",
          "template": "{{ syncState.gmail.nextPageToken }}"
        }
      },
      "pagination": {
        "type": "token",
        "nextTokenField": "nextPageToken",
        "tokenParam": "pageToken",
        "defaultLimit": 100
      },
      "rateLimit": {
        "requestsPerSecond": 5
      }
    },
    "CalendarEvents": {
      "name": "CalendarEvents",
      "method": "GET",
      "path": "/calendar/v3/calendars/primary/events",
      "responseType": "collection",
      "dataPath": "items",
      "queryParams": {
        "maxResults": { "type": "static", "value": 250 }
      },
      "pagination": {
        "type": "token",
        "nextTokenField": "nextPageToken",
        "defaultLimit": 250
      }
    },
    "DriveFiles": {
      "name": "DriveFiles",
      "method": "GET",
      "path": "/drive/v3/files",
      "responseType": "collection",
      "dataPath": "files",
      "queryParams": {
        "pageSize": { "type": "static", "value": 100 },
        "fields": {
          "type": "static",
          "value": "files(id,name,mimeType,size,createdTime,modifiedTime)"
        }
      },
      "pagination": {
        "type": "token",
        "nextTokenField": "nextPageToken",
        "tokenParam": "pageToken"
      }
    }
  },
  "globalRateLimit": {
    "requestsPerSecond": 10
  }
}
```

#### 3. Transform Maps
`config/transform-maps/google-gmail.transform.json`

```json
{
  "id": "google_gmail_to_communication",
  "name": "Gmail to Communication",
  "description": "Gmail messages to internal Communication schema",
  "sourceType": "google_gmail_message",
  "targetType": "communication",
  "fields": {
    "externalId": { "type": "direct", "source": "id" },
    "title": {
      "type": "nested",
      "path": "payload.headers[name=Subject].value"
    },
    "content": {
      "type": "computed",
      "compute": {
        "function": "extractEmailBody",
        "inputs": ["payload"]
      }
    },
    "timestamp": {
      "type": "direct",
      "source": "internalDate",
      "transform": { "type": "date", "format": "unix_ms" }
    }
  },
  "enabled": true
}
```

---

## Validation

### Provider Config Validation

Required fields:
- ✅ `id` - Must be unique UUID or string
- ✅ `name` - Non-empty string
- ✅ `sources` - Array with at least one source
- ✅ `auth` - Valid OAuth configuration
- ✅ `apiSpecId` - Reference to existing API spec

### API Spec Validation

Required fields:
- ✅ `id` - Must be unique
- ✅ `baseUrl` - Valid URL
- ✅ `endpoints` - At least one endpoint defined
- ✅ Each endpoint must have `method`, `path`, `responseType`

### Transform Map Validation

Required fields:
- ✅ `id` - Must be unique
- ✅ `fields` - At least one field mapping
- ✅ Each field must have valid `type`
- ✅ Field types must match their required properties

---

## Best Practices

### 1. Provider Configurations

**✅ DO:**
- Use descriptive names and descriptions
- Enable only essential sources by default
- Request minimum required OAuth scopes
- Include branding for better UX

**❌ DON'T:**
- Request excessive OAuth permissions
- Enable all sources by default
- Use generic descriptions

### 2. API Specifications

**✅ DO:**
- Set reasonable rate limits
- Use pagination for large datasets
- Include timeout values
- Use template params for dynamic values

**❌ DON'T:**
- Hardcode values that should be dynamic
- Skip pagination config for collections
- Set unrealistic rate limits

### 3. Transform Maps

**✅ DO:**
- Use `required: true` for essential fields
- Provide `default` values when appropriate
- Document transformer functions used
- Test with real API responses

**❌ DON'T:**
- Skip error handling with `required`
- Assume field names match exactly
- Forget to transform types (dates, numbers)

### 4. Testing

Before deploying:
1. Validate JSON syntax
2. Check all referenced IDs exist
3. Test with mock data
4. Verify OAuth scopes are correct
5. Test pagination with large datasets

---

## Custom Transformer Functions

The system includes built-in transformer functions:

### Email Transformers
- `extractEmailBody` - Parse email body from MIME parts
- `extractEmailRecipients` - Extract To/CC/BCC addresses
- `parseEmailHeaders` - Structure header data
- `extractEmailSender` - Get From address

### Calendar Transformers
- `parseRecurrenceRule` - Parse RRULE strings
- `extractAttendees` - Normalize attendee data
- `parseCalendarDateTime` - Handle date/time fields
- `extractEventDuration` - Calculate duration

### File Transformers
- `extractFileMetadata` - Parse file metadata
- `generateThumbnailUrl` - Create thumbnail URLs
- `formatFileSize` - Human-readable sizes
- `categorizeFile` - Determine file type
- `extractFileExtension` - Get file extension

To use in transform maps:
```json
{
  "type": "computed",
  "compute": {
    "function": "extractEmailBody",
    "inputs": ["payload"],
    "params": {}
  }
}
```

---

## Additional Resources

- [ETL System Design](./etl-system-design.md)
- [Provider Integration Roadmap](./provider-integration-roadmap.md)
- [Test Account Setup Guide](./test-account-setup-guide.md)
- [TypeScript Type Definitions](../backend/apps/api/src/domains/etl/types/)

---

**Version**: 1.0.0  
**Last Updated**: 2026-02-07  
**Status**: Complete
