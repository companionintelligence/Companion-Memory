# Threads Data Source

Conversation threads for organizing messages between users and the AI assistant.

## CSV File Format

**File name:** `{prefix}-threads.csv` (e.g., `js1-threads.csv`)

**Import order:** 5th (after Providers, Users, Questions, Answers)

## Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | UUID | Unique thread identifier | `01993a4b-6bbf-4bf0-8bc8-59ecb3b768ad` |
| `name` | String | Thread title/name | `Make family dinner tonight` |
| `model` | String | AI model used for thread | `qwen3:8b` |
| `description` | String (can be empty) | Thread description | `` |
| `user_id` | UUID | Owner of the thread | `b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b` |

## Field Details

### `id` - Thread ID
- **Type:** UUID
- **Required:** Yes
- **Unique:** Yes
- **Notes:** Will be referenced by messages and actions

### `name` - Thread Name
- **Type:** String
- **Required:** Yes
- **Max Length:** 500 characters
- **Description:** Display name for the conversation thread
- **Example:** `Plan weekend trip`, `Family dinner ideas`

### `model` - AI Model
- **Type:** String
- **Required:** Yes
- **Description:** The Ollama model used for this thread
- **Common Values:**
  - `qwen3:8b` - Development/staging model
  - `gemma3:1b` - Lightweight model
  - `llama3:70b` - Production model
- **Notes:** Model must be available in Ollama

### `description` - Thread Description
- **Type:** String (can be empty)
- **Required:** No
- **Description:** Optional longer description of thread purpose
- **Notes:** Can be left empty in CSV

### `user_id` - User ID
- **Type:** UUID
- **Required:** Yes
- **Description:** The user who owns this thread
- **Validation:** Must reference existing user

## Example CSV

```csv
id,name,model,description,user_id
01993a4b-6bbf-4bf0-8bc8-59ecb3b768ad,Make family dinner tonight,qwen3:8b,,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b
01993a4b-6bc0-48c7-be52-42b9cd6200b9,Watch a movie together,qwen3:8b,,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b
01993a4b-7cd1-49d8-ad73-53fd0ef311ca,Weekend trip planning,qwen3:8b,Planning a family weekend getaway,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b
```

## Import Behavior

The seed function uses raw SQL INSERT to create thread records. Duplicate handling depends on database constraints.

## Related Data Types

After importing threads:
- [Messages](./messages.md) - Conversation messages within threads
- [Actions](./actions.md) - Recommended actions linked to threads

## Database Schema

```sql
CREATE TABLE threads (
  id UUID PRIMARY KEY,
  name VARCHAR(500) NOT NULL,
  model VARCHAR(100) NOT NULL,
  description TEXT,
  user_id UUID NOT NULL REFERENCES ci_core.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Best Practices

- **Descriptive names:** Use clear, specific thread names
- **Consistent models:** Stick to one model per import unless testing
- **Logical grouping:** Group related conversations in a thread
- **User ownership:** Ensure each thread belongs to the correct user

## Next Steps

1. Create thread data for each conversation topic
2. Ensure thread IDs are unique UUIDs
3. Link threads to existing users
4. Import messages for each thread
5. Optionally link actions to threads
