# Enhanced Camera API Documentation

## Overview
The Enhanced Camera API provides AI-powered media analysis capabilities for images, videos, and audio files. The API can identify people, places, objects, and provide comprehensive scene analysis using state-of-the-art LLM models.

## Base URL
- Development: `https://localhost`
- Staging: `https://your-staging-domain.com`

## Authentication
All endpoints require JWT authentication. Include the token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

## Endpoints

### 1. Analyze Media
**POST** `/api/llm/analyze-media`

Analyzes uploaded media files (images, videos, audio) and returns structured JSON data about detected people, places, objects, and scenes.

#### Request
- **Content-Type**: `multipart/form-data`
- **File Size Limit**: 100MB

#### Form Fields
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | The media file to analyze (image/video/audio) |
| `analysisType` | String | Yes | Type of analysis: `people`, `places`, `objects`, `comprehensive` |
| `model` | String | No | Specific LLM model to use (defaults to best model for media type) |
| `includeMetadata` | Boolean | No | Include technical metadata in results (default: true) |
| `threadId` | String | No | Thread ID for conversation context |

#### Response
```json
{
  "id": "analysis-1234567890",
  "mimetype": "image/jpeg",
  "analysisType": "comprehensive",
  "model": "llama3.2-vision:latest",
  "processedAt": "2025-07-14T10:30:00Z",
  "processingTimeMs": 2500,
  "analysis": {
    "people": [
      {
        "type": "person",
        "name": "Person in red shirt",
        "confidence": 0.92,
        "attributes": {
          "age": "30-40",
          "gender": "female",
          "emotion": "smiling"
        }
      }
    ],
    "places": [
      {
        "type": "place",
        "name": "Modern office",
        "confidence": 0.88,
        "attributes": {
          "type": "indoor",
          "setting": "professional workspace"
        }
      }
    ],
    "objects": [
      {
        "type": "object",
        "name": "Laptop computer",
        "confidence": 0.95,
        "attributes": {
          "color": "silver",
          "size": "medium"
        }
      }
    ],
    "summary": "A professional woman in her 30s wearing a red shirt, smiling while working on a laptop in a modern office environment.",
    "metadata": {
      "resolution": { "width": 1920, "height": 1080 },
      "colors": ["red", "blue", "white"],
      "mood": "positive",
      "fileSize": 2048576
    }
  }
}
```

#### Analysis Types

**`people`** - Focus on detecting and describing people
```json
{
  "analysis": {
    "people": [...],
    "summary": "Description of people in the scene"
  }
}
```

**`places`** - Focus on location and setting identification
```json
{
  "analysis": {
    "places": [...],
    "summary": "Description of location and setting"
  }
}
```

**`objects`** - Focus on object detection and description
```json
{
  "analysis": {
    "objects": [...],
    "summary": "Description of objects in the scene"
  }
}
```

**`comprehensive`** - Complete analysis including all categories
```json
{
  "analysis": {
    "people": [...],
    "places": [...],
    "objects": [...],
    "summary": "Comprehensive scene description",
    "metadata": {...}
  }
}
```

#### Supported Media Types
- **Images**: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- **Videos**: `video/mp4`, `video/webm`, `video/mov`, `video/avi`
- **Audio**: `audio/mp3`, `audio/wav`, `audio/m4a`, `audio/ogg`

#### Error Responses
```json
{
  "error": "Unsupported media type: application/pdf. Supported types: image/*, video/*, audio/*",
  "statusCode": 400
}
```

### 2. Get Available Models
**GET** `/api/llm/models`

Returns a list of available LLM models for media analysis.

#### Response
```json
[
  {
    "model": "llama3.2-vision:latest",
    "namespace": null,
    "name": "llama3.2-vision",
    "tag": "latest"
  },
  {
    "model": "gemma3:1b",
    "namespace": null,
    "name": "gemma3",
    "tag": "1b"
  }
]
```

### 3. Upload File
**POST** `/api/files/upload`

Upload a file to the server for storage and later processing.

#### Request
- **Content-Type**: `multipart/form-data`
- **File Size Limit**: 10GB

#### Form Fields
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | The file to upload |

#### Response
```json
{
  "id": "file-uuid-here",
  "name": "my-image.jpg",
  "contentType": "image/jpeg",
  "size": 2048576
}
```

## Usage Examples

### JavaScript/Node.js
```javascript
const FormData = require('form-data');
const fs = require('fs');

async function analyzeImage(filePath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));
  formData.append('analysisType', 'comprehensive');
  formData.append('includeMetadata', 'true');

  const response = await fetch('https://localhost/api/llm/analyze-media', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer YOUR_JWT_TOKEN',
      ...formData.getHeaders()
    },
    body: formData
  });

  return await response.json();
}
```

### Python
```python
import requests

def analyze_image(file_path):
    with open(file_path, 'rb') as f:
        files = {'file': f}
        data = {
            'analysisType': 'comprehensive',
            'includeMetadata': 'true'
        }
        headers = {
            'Authorization': 'Bearer YOUR_JWT_TOKEN'
        }
        
        response = requests.post(
            'https://localhost/api/llm/analyze-media',
            files=files,
            data=data,
            headers=headers,
            verify=False  # For development only
        )
        
        return response.json()
```

### cURL
```bash
curl -X POST https://localhost/api/llm/analyze-media \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "file=@/path/to/image.jpg" \
  -F "analysisType=comprehensive" \
  -F "includeMetadata=true" \
  --insecure  # For development only
```

## Mobile App Integration

### React Native
```javascript
const analyzeMedia = async (uri, mimeType) => {
  const formData = new FormData();
  formData.append('file', {
    uri,
    type: mimeType,
    name: 'capture.jpg'
  });
  formData.append('analysisType', 'comprehensive');

  const response = await fetch(`${API_BASE_URL}/api/llm/analyze-media`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'multipart/form-data',
    },
    body: formData,
  });

  return response.json();
};
```

### Flutter/Dart
```dart
import 'package:http/http.dart' as http;

Future<Map<String, dynamic>> analyzeMedia(String filePath) async {
  var request = http.MultipartRequest(
    'POST',
    Uri.parse('$baseUrl/api/llm/analyze-media'),
  );
  
  request.headers['Authorization'] = 'Bearer $authToken';
  request.files.add(await http.MultipartFile.fromPath('file', filePath));
  request.fields['analysisType'] = 'comprehensive';
  request.fields['includeMetadata'] = 'true';

  var response = await request.send();
  var responseData = await response.stream.toBytes();
  var responseString = String.fromCharCodes(responseData);
  
  return json.decode(responseString);
}
```

## Rate Limits
- Maximum 100 requests per minute per user
- Maximum file size: 100MB for media analysis
- Processing timeout: 10 minutes for complex video analysis

## Model Recommendations
- **Images**: `llama3.2-vision:latest` (best for visual analysis)
- **Videos**: `llama3.2-vision:latest` (frame analysis)
- **Audio**: `whisper:latest` (transcription) + text analysis model

## Error Handling
The API returns standard HTTP status codes:
- `200` - Success
- `400` - Bad Request (invalid parameters, unsupported file type)
- `401` - Unauthorized (missing or invalid token)
- `413` - Payload Too Large (file size exceeded)
- `422` - Unprocessable Entity (file corrupted or invalid)
- `500` - Internal Server Error

## Performance Tips
1. **Image Optimization**: Resize large images to 1920x1080 for faster processing
2. **Video Preprocessing**: Extract key frames for analysis rather than full video
3. **Batch Processing**: Use file upload + analysis for multiple files
4. **Model Selection**: Choose specific models for better performance
5. **Metadata**: Set `includeMetadata: false` for faster responses when metadata isn't needed

## Security Considerations
- All file uploads are scanned for malicious content
- Files are automatically deleted after processing (configurable retention)
- SSL/TLS encryption in transit
- JWT token expiration and refresh handling
- Rate limiting and abuse prevention
