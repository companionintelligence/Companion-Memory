# Messages Data Source

Messages within conversation threads between users and the AI assistant.

## CSV File Format

**File name:** `{prefix}-messages.csv` (e.g., `js1-messages.csv`)

**Import order:** 7th (after Providers, Users, Questions, Answers, Threads, Actions)

## Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | UUID | Unique message identifier | `01993a4d-cc3c-4c25-ad81-078ddc6e29fe` |
| `model` | String | AI model that generated message | `qwen3:8b` |
| `text` | String | Message content | `Would you like me to help you plan a meal you will all enjoy?` |
| `mimetype` | String | Content type | `text/markdown` |
| `canceled` | Boolean | Whether message was canceled | `false` |
| `user_id` | UUID | User involved in conversation | `b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b` |
| `thread_id` | UUID | Thread this message belongs to | `01993a4b-6bbf-4bf0-8bc8-59ecb3b768ad` |
| `role` | String | Message sender role | `assistant` or `user` |

## Field Details

### `id` - Message ID
- **Type:** UUID
- **Required:** Yes
- **Unique:** Yes

### `model` - AI Model
- **Type:** String
- **Required:** Yes
- **Description:** Model that generated or processed the message
- **Values:** `qwen3:8b`, `gemma3:1b`, `llama3:70b`, etc.

### `text` - Message Content
- **Type:** String (long text)
- **Required:** Yes
- **Description:** The actual message text
- **Format:** Can include markdown formatting
- **Notes:** Supports multi-line text

### `mimetype` - Content MIME Type
- **Type:** String
- **Required:** Yes
- **Common Values:**
  - `text/markdown` - Markdown formatted text (most common)
  - `text/plain` - Plain text
- **Notes:** Indicates how to render the message

### `canceled` - Canceled Status
- **Type:** Boolean
- **Required:** Yes
- **Values:** `true` or `false`
- **Description:** Whether message generation was canceled
- **Typical:** `false` for imported messages

### `user_id` - User ID
- **Type:** UUID
- **Required:** Yes
- **Description:** User associated with this message
- **Validation:** Must reference existing user

### `thread_id` - Thread ID
- **Type:** UUID
- **Required:** Yes
- **Description:** Thread containing this message
- **Validation:** Must reference existing thread

### `role` - Sender Role
- **Type:** String
- **Required:** Yes
- **Values:**
  - `assistant` - Message from AI assistant
  - `user` - Message from human user
  - `system` - System-generated message
- **Description:** Identifies who sent the message

## Example CSV

```csv
id,model,text,mimetype,canceled,user_id,thread_id,role
01993a4d-cc3c-4c25-ad81-078ddc6e29fe,qwen3:8b,Would you like me to help you plan a meal you will all enjoy?,text/markdown,false,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,01993a4b-6bbf-4bf0-8bc8-59ecb3b768ad,assistant
01993a4d-cc3c-4acf-8b45-c6de38526d6a,qwen3:8b,Would you like me to help you find something to watch together?,text/markdown,false,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,01993a4b-6bc0-48c7-be52-42b9cd6200b9,assistant
01993a4d-dd4d-5be6-9c56-d7ef49637e7b,qwen3:8b,"Yes, I'd love some dinner ideas!",text/plain,false,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,01993a4b-6bbf-4bf0-8bc8-59ecb3b768ad,user
```

## Multi-line Messages

For messages with multiple paragraphs, wrap the text field in quotes:

```csv
id,model,text,mimetype,canceled,user_id,thread_id,role
01993a4d-ee5e-6cf7-0d67-e8fg50748f8c,qwen3:8b,"Here are some dinner ideas:

1. Pasta with marinara sauce
2. Grilled chicken with vegetables
3. Homemade pizza

What sounds good to you?",text/markdown,false,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,01993a4b-6bbf-4bf0-8bc8-59ecb3b768ad,assistant
```

## Conversation Flow

Messages should be ordered chronologically within a thread:
1. User message (role: `user`)
2. Assistant response (role: `assistant`)
3. User reply (role: `user`)
4. Assistant response (role: `assistant`)
...and so on

## Import Behavior

Messages are imported using raw SQL INSERT. Ensure:
- Thread exists before importing its messages
- User exists before importing their messages
- Messages are in chronological order for realistic conversations

## Database Schema

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  model VARCHAR(100) NOT NULL,
  text TEXT NOT NULL,
  mimetype VARCHAR(100) NOT NULL,
  canceled BOOLEAN DEFAULT false,
  user_id UUID NOT NULL REFERENCES ci_core.users(id),
  thread_id UUID NOT NULL REFERENCES threads(id),
  role VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Best Practices

- **Natural conversation:** Create realistic back-and-forth exchanges
- **Appropriate length:** Vary message lengths naturally
- **Use markdown:** Format assistant messages with markdown for better display
- **Chronological order:** Import messages in the order they occurred
- **Consistent roles:** Alternate between user and assistant appropriately

## Troubleshooting

### Issue: "Text contains unescaped quotes"

**Solution:** Wrap the entire text field in double quotes and escape internal quotes:
```csv
text
"He said ""Hello"" to me"
```

### Issue: "Foreign key violation on thread_id"

**Solution:** Import threads before messages.

## Next Steps

1. Create conversation scripts for your threads
2. Assign proper roles (user/assistant) to each message
3. Ensure thread_id references exist
4. Import messages in chronological order
5. Verify conversations flow naturally
