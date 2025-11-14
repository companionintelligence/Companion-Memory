# Questions Data Source

Intelligence questions that users can answer to build their profile and help the AI companion understand them better.

## CSV File Format

**File name:** `questions.csv`

**Import order:** 3rd (after Providers and Users)

**Location:** `backend/apps/api/scripts/seed-database/intelligence-data/questions.csv`

## Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | UUID | Unique question identifier | `d53229b9-0fa0-487b-b494-d65c42a4e1ae` |
| `category` | String | Main category of the question | `Core Identity` |
| `subcategory` | String or Empty | Subcategory (can be empty) | `` |
| `user_id` | UUID | User this question is for | `b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b` |
| `question_string` | String | The actual question text | `What are the five words you would use to describe your fundamental self?` |
| `example_answer_1` | String | Example answer to guide users | `Curious, resilient, empathetic, analytical, reserved.` |

## Field Details

### `id` - Question ID
- **Type:** UUID (v7 recommended)
- **Required:** Yes
- **Unique:** Yes
- **Description:** Permanent unique identifier for the question
- **Notes:** Referenced by answers table

### `category` - Question Category
- **Type:** String
- **Required:** Yes
- **Description:** Primary category for organizing questions
- **Common Values:**
  - `Core Identity`
  - `Values & Beliefs`
  - `Relationships`
  - `Life Goals`
  - `Daily Habits`
  - `Preferences`
  - `Health & Wellness`
  - `Work & Career`
  - `Hobbies & Interests`
- **Notes:** Stored in `question_category` field and added to `context_tags` array

### `subcategory` - Question Subcategory
- **Type:** String (can be empty)
- **Required:** No
- **Description:** Optional subcategory for finer categorization
- **Example:** For category `Relationships`, subcategory might be `Family` or `Friends`
- **Notes:** If provided, added to `context_tags` array

### `user_id` - User ID
- **Type:** UUID
- **Required:** Yes
- **Description:** The user this question is intended for
- **Notes:** Must reference an existing user from the users CSV
- **Validation:** Foreign key to `ci_core.users.id`

### `question_string` - Question Text
- **Type:** String (long text)
- **Required:** Yes
- **Description:** The actual question to ask the user
- **Max Length:** 1000 characters (recommended)
- **Best Practices:**
  - Be specific and clear
  - Use open-ended phrasing
  - Encourage thoughtful reflection
  - Avoid yes/no questions when possible

### `example_answer_1` - Example Answer
- **Type:** String (long text)
- **Required:** Yes
- **Description:** A sample answer to help users understand the depth expected
- **Purpose:** 
  - Guides users on how detailed their answer should be
  - Shows the tone and style of responses
  - Not used as actual user data

## Auto-Generated Fields

During import, the following fields are automatically set:

| Field | Value | Description |
|-------|-------|-------------|
| `question_id` | Same as `id` | Question identifier in questions table |
| `question_text` | Same as `question_string` | The question text |
| `question_category` | From `category` field | Primary category |
| `context_tags` | Array of category + subcategory | Tags for search and filtering |
| `question_type` | `open_ended` | Type of question (all CSV imports are open-ended) |
| `is_seed_question` | `true` | Marks as initial curated question |
| `created_by_llm` | `false` | Indicates human-curated |
| `frequency_recommendation` | `one_time` | How often to ask (default) |
| `is_active` | `true` | Whether question is currently active |

## Example CSV

```csv
id,category,subcategory,user_id,question_string,example_answer_1
d53229b9-0fa0-487b-b494-d65c42a4e1ae,Core Identity,,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,What are the five words you would use to describe your fundamental self?,"Curious, resilient, empathetic, analytical, reserved."
6e5f1233-f06b-49df-b8fe-c6d9ba6a9368,Core Identity,,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,What are three core values that guide your major life decisions?,"Integrity, compassion, and personal growth."
5d59cc37-2627-4b1f-88fc-d352428d98b3,Core Identity,,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,"How did you come to hold these values? Were they taught, learned through experience, or a combination?","A combination; my parents emphasized integrity, but compassion and personal growth became important through my own experiences and reflections."
```

## Context Tags

The `context_tags` array is automatically built from the `category` and `subcategory` fields:

- If only `category` is provided: `context_tags = ['Core Identity']`
- If both are provided: `context_tags = ['Relationships', 'Family']`

This allows for flexible filtering and searching of questions.

## Import Behavior

### Duplicate Handling
- Uses `ON CONFLICT (question_id) DO NOTHING`
- If a question with the same `id` exists, it's skipped
- No error is thrown for duplicates

### Error Conditions

**Import will fail if:**
- `user_id` doesn't reference an existing user
- `id` is not a valid UUID
- Required fields are missing
- `question_string` is empty

## Question Writing Guidelines

When creating questions for import:

### Good Questions
✅ **Specific and Focused**
- "What is your morning routine on a typical weekday?"
- "Describe your ideal weekend activity."

✅ **Open-Ended**
- "How do you handle stress?"
- "What motivates you to pursue your goals?"

✅ **Reflective**
- "What life experience has shaped you the most?"
- "How have your priorities changed over the years?"

### Avoid
❌ **Yes/No Questions** (unless intentional)
- "Do you like coffee?" → Better: "What is your relationship with coffee?"

❌ **Too Broad**
- "Tell me about yourself." → Better: "What are five words that describe you?"

❌ **Leading Questions**
- "Why don't you exercise more?" → Better: "How do you incorporate movement into your life?"

## Example Answer Guidelines

Example answers should:
- Be realistic and relatable
- Show appropriate detail level (2-3 sentences typically)
- Use natural language
- Demonstrate the kind of insight expected
- Not be too perfect or aspirational

## Question Categories

### Suggested Category Taxonomy

**Identity & Self**
- Core Identity
- Personality Traits
- Self-Perception

**Values & Philosophy**
- Core Values
- Beliefs
- Life Philosophy
- Spirituality

**Relationships**
- Family (subcategory)
- Friends (subcategory)
- Romantic (subcategory)
- Professional (subcategory)

**Life & Goals**
- Life Goals
- Career Aspirations
- Personal Growth
- Achievements

**Daily Life**
- Routines
- Habits
- Preferences
- Time Management

**Interests**
- Hobbies
- Entertainment
- Learning
- Creativity

**Health & Wellness**
- Physical Health
- Mental Health
- Nutrition
- Exercise

**Work & Career**
- Career Path
- Work Style
- Professional Skills
- Work-Life Balance

## Database Schema

Questions are stored in the `questions` table:

```sql
CREATE TABLE questions (
  question_id UUID PRIMARY KEY,
  question_text TEXT NOT NULL,
  question_category VARCHAR(255),
  context_tags TEXT[],
  question_type VARCHAR(50) DEFAULT 'open_ended',
  is_seed_question BOOLEAN DEFAULT false,
  created_by_llm BOOLEAN DEFAULT false,
  frequency_recommendation VARCHAR(50) DEFAULT 'one_time',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Related Data Types

After importing questions:
- Import [Answers](./answers.md) - User responses to these questions
- Questions can be referenced in conversation contexts

## Example Code

### Generate Questions CSV

```javascript
import { v7 as uuidv7 } from 'uuid';
import { stringify } from 'csv-stringify/sync';
import fs from 'fs';

const userId = 'b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b'; // Must exist

const questions = [
  {
    id: uuidv7(),
    category: 'Core Identity',
    subcategory: '',
    user_id: userId,
    question_string: 'What are your three most important values?',
    example_answer_1: 'Honesty, kindness, and personal growth.'
  },
  {
    id: uuidv7(),
    category: 'Daily Habits',
    subcategory: 'Morning Routine',
    user_id: userId,
    question_string: 'Describe your ideal morning routine.',
    example_answer_1: 'I wake at 6am, meditate for 10 minutes, then enjoy coffee while reading.'
  }
];

const csv = stringify(questions, { header: true });
fs.writeFileSync('questions.csv', csv);
```

## Bulk Question Import

For importing large question sets:

1. **Create a master question bank** with diverse categories
2. **Assign questions to users** - same questions can go to multiple users
3. **Use consistent categories** for better organization
4. **Provide quality examples** to guide meaningful responses

## Troubleshooting

### Issue: "Foreign key violation on user_id"

**Solution:** Ensure the `user_id` exists in the users table. Import users first.

### Issue: "Question text too long"

**Solution:** Keep question text concise. Consider splitting complex questions into multiple simpler ones.

### Issue: "Empty context_tags array"

**Solution:** This happens when both category and subcategory are empty. Provide at least a category.

## Next Steps

1. Design your question taxonomy (categories and subcategories)
2. Write thoughtful, open-ended questions
3. Create example answers for each question
4. Generate UUIDs for each question
5. Assign questions to users
6. Import questions CSV
7. Import [answers](./answers.md) for user responses
