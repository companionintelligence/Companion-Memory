# Testing Ollama Connection Issue Fix

This document explains how to test the fix for issue #173: "Initial call to models fails"

## How to Reproduce the Issue

The issue occurs when the Ollama service is not running but the application tries to call `getAvailableModels()` or related methods.

### Without the Fix:
- The service would throw an unhandled `TypeError: fetch failed` with cause `ECONNREFUSED`
- This would crash or fail silently depending on where it was called

### With the Fix:
- `getAvailableModels()` returns an empty array and logs a warning
- `validateModel()` returns a default parsed model when no models are available  
- `generate()` and `chat()` methods provide clear error messages about Ollama service unavailability

## Test Script

To test the fix, you can run this TypeScript code in the backend/apps/api directory:

```typescript
import { OllamaService } from './src/domains/llm/services/OllamaService';
import { MessageService } from './src/domains/conversations/services/MessageService';
import { DataSource } from 'typeorm';
import type { RequestContext } from './src/common/types';

// Mock dependencies for testing
const mockDataSource = {} as DataSource;
const mockMessageService = {} as MessageService;

async function testOllamaErrorHandling() {
  const ollamaService = new OllamaService(mockMessageService, mockDataSource);
  const mockContext: RequestContext = { userId: 'test-user' };

  console.log('Testing Ollama error handling with service NOT running...');

  // Test 1: getAvailableModels should return empty array
  const models = await ollamaService.getAvailableModels(mockContext);
  console.log('✓ getAvailableModels:', models.length === 0 ? 'PASS' : 'FAIL');

  // Test 2: validateModel should return default model
  const validatedModel = await ollamaService.validateModel(mockContext, undefined);
  console.log('✓ validateModel:', validatedModel.model === 'gemma3:1b' ? 'PASS' : 'FAIL');

  // Test 3: generate should fail gracefully with clear error
  try {
    await ollamaService.generate(mockContext, 'Test prompt');
    console.log('✗ generate should have failed');
  } catch (error) {
    const hasProperError = (error as Error).message.includes('Ollama service unavailable');
    console.log('✓ generate error handling:', hasProperError ? 'PASS' : 'FAIL');
  }

  console.log('All tests completed!');
}

testOllamaErrorHandling();
```

## Expected Output

When running the test with Ollama NOT running, you should see:
- Warning logs about failed Ollama connection
- Empty array returned from getAvailableModels
- Default model returned from validateModel  
- Clear error messages from generate/chat methods
- No unhandled errors or crashes

## Manual Testing

1. Ensure Ollama is NOT running: `pkill ollama` or don't start it
2. Start the backend API server
3. Make a request to `/llm/models` endpoint - should return empty array with 200 status
4. Try to use the generate endpoint - should return clear error message about service unavailability