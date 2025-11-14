# Answers Data Source

User answers to intelligence questions that help build their personal profile.

## CSV File Format

**File name:** `{prefix}-answers.csv` (e.g., `js1-answers.csv`)

**Import order:** 4th (after Providers, Users, Questions)

## Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | UUID | Unique answer identifier | `01993a45-1122-3344-5566-778899aabbcc` |
| `question_id` | UUID | Question being answered | `d53229b9-0fa0-487b-b494-d65c42a4e1ae` |
| `user_id` | UUID | User providing the answer | `b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b` |
| `answer_text` | String | The user's answer | `I would describe myself as curious, empathetic, analytical, creative, and introverted.` |
| `created_at` | ISO 8601 Date | When answer was created | `2025-05-20T10:30:00Z` |
| `updated_at` | ISO 8601 Date | When answer was last updated | `2025-05-20T10:30:00Z` |

## Field Details

### `id` - Answer ID
- **Type:** UUID
- **Required:** Yes
- **Unique:** Yes

### `question_id` - Question ID
- **Type:** UUID
- **Required:** Yes
- **Validation:** Must reference existing question
- **Notes:** Links answer to specific question

### `user_id` - User ID
- **Type:** UUID
- **Required:** Yes
- **Validation:** Must reference existing user

### `answer_text` - Answer Content
- **Type:** String (long text)
- **Required:** Yes
- **Description:** The user's response to the question
- **Best Practices:**
  - Thoughtful, detailed responses
  - Natural, conversational language
  - 1-5 sentences typically
  - Reflects user's authentic voice

### `created_at` / `updated_at` - Timestamps
- **Type:** ISO 8601 DateTime
- **Required:** Yes
- **Format:** `YYYY-MM-DDTHH:MM:SSZ`

## Example CSV

```csv
id,question_id,user_id,answer_text,created_at,updated_at
01993a45-1122-3344-5566-778899aabbcc,d53229b9-0fa0-487b-b494-d65c42a4e1ae,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,"I would describe myself as curious, empathetic, analytical, creative, and introverted.",2025-05-20T10:30:00Z,2025-05-20T10:30:00Z
01993a45-2233-4455-6677-889900bbccdd,6e5f1233-f06b-49df-b8fe-c6d9ba6a9368,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,"My three core values are integrity, compassion, and continuous learning. These guide all my major decisions.",2025-05-20T11:00:00Z,2025-05-20T11:00:00Z
```

## Multi-line Answers

For answers with multiple paragraphs:

```csv
id,question_id,user_id,answer_text,created_at,updated_at
01993a45-3344-5566-7788-99aa00bbccdd,5d59cc37-2627-4b1f-88fc-d352428d98b3,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,"My values are a combination of teaching and experience.

My parents emphasized integrity from a young age. Compassion grew through volunteering and seeing others' struggles. Personal growth became important after realizing I wanted to keep evolving throughout life.",2025-05-20T11:30:00Z,2025-05-20T11:30:00Z
```

## Database Schema

```sql
CREATE TABLE answers (
  id UUID PRIMARY KEY,
  question_id UUID NOT NULL REFERENCES questions(question_id),
  user_id UUID NOT NULL REFERENCES ci_core.users(id),
  answer_text TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE
);
```

## Best Practices

- **Authentic responses:** Write answers as the user would
- **Appropriate detail:** Match the depth of example answers
- **Chronological timestamps:** Later questions should have later timestamps
- **Consistency:** Answers should align with user's overall profile

## Next Steps

1. Review questions to understand what's being asked
2. Write thoughtful, personalized answers for each user
3. Ensure question_id references are correct
4. Import and verify answers are associated with correct questions
