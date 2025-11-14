# Answers Data Source

User answers to intelligence questions that help build their personal profile.

## CSV File Format

**File name:** `{prefix}-answers.csv` (e.g., `js1-answers.csv`)

**Import order:** 4th (after Providers, Users, Questions)

## Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | UUID | Unique answer identifier | `01993a45-1122-3344-5566-778899aabbcc` |
| `user_id` | UUID | User providing the answer | `b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b` |
| `question_id` | UUID | Question being answered | `d53229b9-0fa0-487b-b494-d65c42a4e1ae` |
| `give_answer_1` | String | The user's answer | `I would describe myself as curious, empathetic, analytical, creative, and introverted.` |

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

### `give_answer_1` - Answer Content
- **Type:** String (long text)
- **Required:** Yes
- **Description:** The user's response to the question
- **Field Name Note:** Uses legacy field name `give_answer_1` from original schema
- **Best Practices:**
  - Thoughtful, detailed responses
  - Natural, conversational language
  - 1-5 sentences typically
  - Reflects user's authentic voice

## Auto-Generated Fields

During import, additional fields are automatically set:

| Field | Value | Description |
|-------|-------|-------------|
| `answer_id` | Same as `id` | Primary key in answers table |
| `answer_text` | From `give_answer_1` | Mapped to new schema field |
| `answer_source` | `imported` | Marks as imported data |
| `answer_method` | `survey` | Original collection method |
| `answered_at` | `NOW()` | Timestamp of import |
| `is_sensitive` | `false` | Default for seed data |
| `sharing_level` | `private` | Default privacy setting |

## Example CSV

```csv
id,user_id,question_id,give_answer_1
01993a45-1122-3344-5566-778899aabbcc,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,d53229b9-0fa0-487b-b494-d65c42a4e1ae,"I would describe myself as curious, empathetic, analytical, creative, and introverted."
01993a45-2233-4455-6677-889900bbccdd,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,6e5f1233-f06b-49df-b8fe-c6d9ba6a9368,"My three core values are integrity, compassion, and continuous learning. These guide all my major decisions."
```

## Multi-line Answers

For answers with multiple paragraphs:

```csv
id,user_id,question_id,give_answer_1
01993a45-3344-5566-7788-99aa00bbccdd,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,5d59cc37-2627-4b1f-88fc-d352428d98b3,"My values are a combination of teaching and experience.

My parents emphasized integrity from a young age. Compassion grew through volunteering and seeing others' struggles. Personal growth became important after realizing I wanted to keep evolving throughout life."
```

## Database Schema

```sql
CREATE TABLE answers (
  answer_id UUID PRIMARY KEY,
  question_id UUID NOT NULL REFERENCES questions(question_id),
  user_id UUID NOT NULL REFERENCES ci_core.users(id),
  answer_text TEXT NOT NULL,
  answer_source VARCHAR(50),
  answer_method VARCHAR(50),
  answered_at TIMESTAMP WITH TIME ZONE,
  is_sensitive BOOLEAN DEFAULT false,
  sharing_level VARCHAR(50) DEFAULT 'private'
);
```

## Best Practices

- **Authentic responses:** Write answers as the user would
- **Appropriate detail:** Match the depth of example answers
- **Consistency:** Answers should align with user's overall profile
- **Column order:** Use `id,user_id,question_id,give_answer_1` order as shown in examples

## Next Steps

1. Review questions to understand what's being asked
2. Write thoughtful, personalized answers for each user
3. Ensure question_id references are correct
4. Import and verify answers are associated with correct questions
