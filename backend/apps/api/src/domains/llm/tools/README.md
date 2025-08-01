# LLM Tools System

## Overview

This system provides extensible function calling capabilities for your LLM-powered assistant. It allows the AI to query your database and execute actions when appropriate context is needed.

## Architecture

### Core Components

1. **BaseTool** - Abstract base class with error handling and observability
2. **ToolRegistry** - Service for registering and executing tools  
3. **EnhancedOllamaService** - LLM service with function calling support
4. **ToolsController** - API endpoints for tool-enabled conversations

### Current Tools

- `get_user_preferences` - Query user dietary preferences and restrictions
- `get_family_members` - Get family member information with optional preferences

## Usage

### Basic Function Calling

```typescript
POST /llm/tools/chat
{
  "messages": [
    {
      "prompt": true,
      "text": "What should I consider when planning dinner?"
    }
  ],
  "enableTools": true
}
```

### Dinner Planning Example

The AI will automatically:
1. Recognize dinner planning context
2. Call `get_user_preferences()` and `get_family_members()`  
3. Use the returned data to make personalized recommendations

## Adding New Tools

### 1. Create Tool Implementation

```typescript
@Injectable()
export class MyNewTool extends BaseTool<InputType, OutputType> {
  readonly schema = {
    name: 'my_new_tool',
    description: 'What this tool does',
    parameters: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'Parameter description' }
      }
    }
  };

  protected async executeInternal(context, input): Promise<OutputType> {
    // Implementation here
  }
}
```

### 2. Register in ToolsModule

```typescript
@Module({
  providers: [..., MyNewTool],
  exports: [..., MyNewTool],
})
export class ToolsModule {
  constructor(..., private readonly myNewTool: MyNewTool) {
    this.toolRegistry.register(this.myNewTool);
  }
}
```

## Key Features

### Error Handling
- Standardized error format across all tools
- Automatic retry suggestions for transient failures
- Detailed logging with sensitive data sanitization

### Observability  
- Execution time tracking
- Input/output logging (with sanitization)
- Tool usage metrics
- Unique execution IDs for tracing

### Security
- Tools run with user context (user ID, permissions)
- Input validation using Zod schemas
- Sensitive data sanitization in logs

## Model Compatibility

Currently tested with:
- `gemma3:1b` (basic function calling)
- Recommend upgrading to `gemma3:8b` or `gemma3:27b` for better function calling

## Testing

1. **Setup test data**: Run `test_data.sql` to create sample preferences and family members
2. **Test tools directly**: Use the examples in `TOOLS_TESTING.md`
3. **Integration testing**: The dinner planning scenario exercises the full flow

## Future Enhancements

- Tool composition (tools calling other tools)
- Caching layer for expensive operations  
- Rate limiting and resource management
- A/B testing different tool implementations
- Dynamic tool loading/hot-reloading
