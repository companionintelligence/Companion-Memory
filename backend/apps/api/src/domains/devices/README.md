# Device Data Ingestion API

This module provides API endpoints for CI Connect client apps to register devices and ingest data from mobile (iOS, Android) and desktop (Windows, Mac) platforms.

## API Endpoints

### Device Management

#### Register/Update Device
```
POST /devices/register
```

Registers a new device or updates an existing one if the device identifier already exists for the user.

**Request Body:**
```json
{
  "deviceName": "John's iPhone",
  "platform": "ios",
  "deviceIdentifier": "unique-device-id",
  "appVersion": "1.0.0",
  "osVersion": "iOS 17.0",
  "metadata": {
    "model": "iPhone 15 Pro",
    "carrier": "Verizon"
  }
}
```

#### Get User Devices
```
GET /devices
```

Returns all devices registered for the authenticated user.

#### Get Device Details
```
GET /devices/{deviceId}
```

Returns details for a specific device.

#### Update Device
```
PUT /devices/{deviceId}
```

Updates device information.

#### Delete Device
```
DELETE /devices/{deviceId}
```

Removes a device and all its data.

### Data Ingestion

#### Ingest Device Data
```
POST /devices/{deviceId}/data
```

Ingests data collected from the device.

**Request Body:**
```json
{
  "data": [
    {
      "dataType": "file_activity",
      "timestamp": "2025-09-01T14:30:00.000Z",
      "payload": {
        "action": "opened",
        "fileName": "document.pdf",
        "fileSize": 1024000
      },
      "sourceApp": "Adobe Acrobat",
      "filePath": "/Users/john/Documents/document.pdf",
      "fileType": "pdf",
      "activityType": "open"
    },
    {
      "dataType": "app_usage",
      "timestamp": "2025-09-01T14:30:00.000Z",
      "payload": {
        "appName": "Safari",
        "bundleId": "com.apple.Safari",
        "usage": "foreground"
      },
      "sourceApp": "Safari",
      "durationSeconds": 120
    },
    {
      "dataType": "location",
      "timestamp": "2025-09-01T14:30:00.000Z",
      "payload": {
        "accuracy": 5,
        "altitude": 100
      },
      "latitude": 37.7749,
      "longitude": -122.4194
    }
  ]
}
```

#### Get Device Data
```
GET /devices/{deviceId}/data
```

Retrieves collected data for a device with optional filtering and pagination.

**Query Parameters:**
- `dataType` (optional): Filter by data type
- `startTime` (optional): Filter by start time
- `endTime` (optional): Filter by end time
- `limit` (optional): Number of records to return (default: 100, max: 1000)
- `offset` (optional): Number of records to skip (default: 0)

#### Get Device Data Statistics
```
GET /devices/{deviceId}/stats
```

Returns aggregated statistics about collected data types.

## Data Types

The system supports the following data types:

- `file_activity`: File operations (create, edit, open, delete, rename, move)
- `app_usage`: Application usage tracking
- `media_played`: Media playback events
- `notification`: System and app notifications
- `location`: GPS location data
- `device_usage`: General device usage metrics
- `system_info`: System information and health metrics

## Platforms

Supported platforms:
- `ios`: iOS devices (iPhone, iPad)
- `android`: Android devices
- `windows`: Windows desktop/laptop
- `mac`: macOS desktop/laptop

## Authentication

All endpoints require JWT authentication. Include the JWT token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

## Rate Limiting

- Data ingestion is limited to 1000 data points per request
- Device registration is limited per user to prevent abuse

## Error Responses

All endpoints return errors in the following format:

```json
{
  "statusCode": 404,
  "message": "Device not found",
  "error": "Not Found"
}
```

Common error codes:
- `400`: Bad Request (validation errors)
- `401`: Unauthorized (missing or invalid JWT)
- `404`: Not Found (device doesn't exist)
- `409`: Conflict (device identifier already exists for another user)
- `500`: Internal Server Error