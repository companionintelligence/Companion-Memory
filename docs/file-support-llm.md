# File Support for LLM Endpoints

This document describes the enhanced file support capabilities added to the LLM endpoints.

## Overview

The `/llm/generate` endpoint now supports file uploads alongside text prompts, enabling multimodal interactions with various file types including images, PDFs, and text documents.

## API Changes

### Request Schema

The endpoint now accepts an optional `fileIds` array parameter:

```typescript
{
  prompt?: string;          // Optional text prompt
  fileIds?: string[];      // Optional array of file IDs
  model?: string;
  threadId?: string;
  enableTools?: boolean;
  enableThinking?: boolean;
}
```

**Note:** Either `prompt` or `fileIds` (or both) must be provided.

### File Processing Workflow

1. **Upload Files**: First, upload files using the existing `/files/upload` endpoint
2. **Get File IDs**: Extract the file IDs from the upload response
3. **Send to LLM**: Include the file IDs in your LLM request

## Supported File Types

### Images
- **Formats**: JPEG, PNG, GIF, WebP, TIFF
- **Features**: 
  - EXIF metadata extraction (camera info, GPS location, timestamps)
  - Image dimensions
  - Automatic vision model integration

### PDF Documents
- **Features**:
  - Full text extraction
  - Document metadata (title, author, creation date)
  - Page count information

### Text Files
- **Formats**: Plain text, JSON, XML, YAML, CSV, SQL, Markdown, Code files
- **Features**:
  - Full content extraction
  - Automatic encoding detection

### Future Support (Framework in Place)
- **Audio**: Metadata extraction, transcription support
- **Video**: Frame extraction, metadata, duration
- **Office Documents**: Word, Excel, PowerPoint

## Usage Examples

### File-Only Request (No Text Prompt)
```typescript
const response = await fetch('/llm/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    fileIds: ['file-id-1', 'file-id-2']
  })
});
```

The system automatically generates a descriptive prompt like:
> "I've uploaded 2 file(s): Image, PDF Document. Please analyze and discuss them:
> 
> File: photo.jpg (Image)
> Dimensions: 1920x1080
> Location: 37.7749, -122.4194
> Camera info: Make: Apple, Model: iPhone 14 Pro
> 
> File: document.pdf (PDF Document)
> Content preview: This document contains important information..."

### Combined Text + Files Request
```typescript
const response = await fetch('/llm/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: "Please analyze these files and create a summary report",
    fileIds: ['file-id-1', 'file-id-2']
  })
});
```

## Thread Integration

Files are automatically associated with chat threads, providing persistent context across the conversation. This enables:

- **Continuous Reference**: Files remain available throughout the conversation
- **Multi-turn Analysis**: Follow-up questions about uploaded files
- **Context Preservation**: File metadata persists in thread history

## Error Handling

The system provides comprehensive error handling:

- **File Validation**: Ensures all provided file IDs exist and belong to the user
- **Processing Errors**: Graceful handling of corrupted or unsupported files
- **Security**: Files are scoped to the authenticated user only

## Technical Implementation

### File Processing Pipeline

1. **Validation**: Verify file ownership and existence
2. **Content Retrieval**: Fetch file content from S3/Minio storage
3. **Metadata Extraction**: Process files based on MIME type
4. **Context Generation**: Create descriptive analysis prompts
5. **Thread Association**: Link files to conversation threads
6. **LLM Integration**: Pass processed content to Ollama

### Metadata Extraction Libraries

- **Images**: `exifr` for comprehensive EXIF data extraction
- **PDFs**: `pdf-parse` for text and metadata extraction
- **Text**: Built-in UTF-8 decoding with encoding detection

## Development Notes

### Extending File Support

To add support for new file types, extend the `FileProcessingService`:

1. Add new MIME type detection in `extractMetadata()`
2. Implement extraction method (e.g., `extractAudioMetadata()`)
3. Update `getFileTypeDescription()` for user-friendly names
4. Add comprehensive tests

### Configuration

File processing behavior is configurable through:
- File size limits (currently 10GB)
- Supported MIME types
- Metadata extraction depth
- Error handling preferences

## Security Considerations

- All file access is user-scoped and authenticated
- Files are validated before processing
- Metadata extraction is sandboxed
- No file content is stored in logs
- Temporary processing data is cleaned up automatically

## Performance Notes

- Large files are processed asynchronously
- Metadata extraction is optimized for common file types
- File content is streamed efficiently to avoid memory issues
- Caching is implemented for frequently accessed metadata