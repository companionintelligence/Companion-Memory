# Actions Data Source

Recommended actions suggested by the AI companion to help users improve their daily life.

## CSV File Format

**File name:** `{prefix}-actions.csv` (e.g., `js1-actions.csv`)

**Import order:** 6th (after Providers, Users, Questions, Answers, Threads)

## Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | UUID | Unique action identifier | `01993a46-5475-4d58-b2c7-78809e7e75ee` |
| `title` | String | Action title | `Make family dinner tonight` |
| `text` | String | Action description/reasoning | `Because you haven't made a home-cooked meal yet this week, I am recommending you plan something together with the family.` |
| `image_url` | String | Path to action image | `/actions/dinner.jpg` |
| `thread_id` | UUID | Related conversation thread | `01993a4b-6bbf-4bf0-8bc8-59ecb3b768ad` |
| `user_id` | UUID | User this action is for | `b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b` |
| `tags` | Array String | Tags for categorization | `['Culinary', 'Family']` |

## Field Details

### `id` - Action ID
- **Type:** UUID
- **Required:** Yes
- **Unique:** Yes

### `title` - Action Title
- **Type:** String
- **Required:** Yes
- **Max Length:** 255 characters
- **Description:** Short, actionable title
- **Best Practices:**
  - Start with a verb when possible
  - Be specific and clear
  - Keep under 50 characters for better display

### `text` - Action Description
- **Type:** String (long text)
- **Required:** Yes
- **Description:** Explains why this action is recommended
- **Best Practices:**
  - Provide context and reasoning
  - Use personal, empathetic language
  - Connect to user's goals or situation
  - 1-3 sentences ideal

### `image_url` - Image Path
- **Type:** String (URL/path)
- **Required:** Yes
- **Description:** Path to action's visual representation
- **Format:** Relative path from web root
- **Example:** `/actions/dinner.jpg`, `/actions/movie_night.jpg`
- **Notes:** Images should exist in the frontend static assets

### `thread_id` - Thread ID
- **Type:** UUID
- **Required:** Yes
- **Description:** Related conversation thread
- **Validation:** Must reference existing thread
- **Purpose:** Links action to the conversation that prompted it

### `user_id` - User ID
- **Type:** UUID
- **Required:** Yes
- **Description:** User this action is recommended for
- **Validation:** Must reference existing user

### `tags` - Tags Array
- **Type:** Array of strings (Python list format in CSV)
- **Required:** Yes (can be empty array)
- **Description:** Categories/tags for organizing and filtering actions
- **Format:** `['Tag1', 'Tag2', 'Tag3']` (with single quotes)
- **Common Tags:**
  - `Family`, `Friends`, `Social`
  - `Health`, `Wellness`, `Exercise`
  - `Culinary`, `Cooking`
  - `Entertainment`, `Movies`, `Music`
  - `Learning`, `Reading`
  - `Productivity`, `Organization`
  - `Self-Care`, `Relaxation`

## Example CSV

```csv
id,title,text,image_url,thread_id,user_id,tags
01993a46-5475-4d58-b2c7-78809e7e75ee,Make family dinner tonight,"Because you haven't made a home-cooked meal yet this week, I am recommending you plan something together with the family.",/actions/dinner.jpg,01993a4b-6bbf-4bf0-8bc8-59ecb3b768ad,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,"['Culinary', 'Family']"
01993a46-5475-42f2-8a63-4f3e9eafe02b,Watch a movie together,Why don't you invite your family to watch a movie together tonight? It's a simple way for you to relax and enjoy some quality time with them.,/actions/movie_night.jpg,01993a4b-6bc0-48c7-be52-42b9cd6200b9,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,"['Entertainment', 'Movies', 'Family Time']"
01993a46-6586-53g3-9b74-5g4f0fbgf13c,Go for a morning walk,You mentioned wanting to be more active. A 20-minute morning walk could be a great way to start your day with energy.,/actions/morning_walk.jpg,01993a4b-7cd1-49d8-ad73-53fd0ef311ca,b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b,"['Health', 'Exercise', 'Morning Routine']"
```

## Tags Format

Tags must be in Python list format with single quotes:

✅ Correct:
```csv
"['Cooking', 'Family']"
"['Health']"
"['Entertainment', 'Movies', 'Family Time']"
```

❌ Incorrect:
```csv
["Cooking", "Family"]  // Wrong: double quotes
[Cooking, Family]      // Wrong: no quotes
Cooking, Family        // Wrong: not an array
```

## Action Writing Guidelines

### Good Action Titles
✅ **Specific and actionable:**
- "Call Mom this weekend"
- "Try a new recipe tonight"
- "Spend 10 minutes journaling"

### Good Action Descriptions
✅ **Personal and contextual:**
- "You mentioned feeling disconnected from family. A quick call could brighten both your days."
- "Based on your love of Italian food, here's a simple pasta recipe to try."

### Tag Strategy
- Use 2-4 tags per action
- Include one category tag (Family, Health, etc.)
- Include one activity tag (Cooking, Exercise, etc.)
- Add context tags when relevant (Weekend, Morning Routine, etc.)

## Import Behavior

The seed function:
1. Parses tags from string format to array
2. Creates or retrieves tag entities
3. Associates tags with the action
4. Links action to user and thread

## Database Schema

```sql
CREATE TABLE actions (
  id UUID PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  text TEXT NOT NULL,
  image_url VARCHAR(500),
  thread_id UUID REFERENCES threads(id),
  user_id UUID NOT NULL REFERENCES ci_core.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tags stored separately and linked via junction table
CREATE TABLE tags (
  id UUID PRIMARY KEY,
  label VARCHAR(100) NOT NULL,
  user_id UUID REFERENCES ci_core.users(id)
);

CREATE TABLE action_tags (
  action_id UUID REFERENCES actions(id),
  tag_id UUID REFERENCES tags(id),
  PRIMARY KEY (action_id, tag_id)
);
```

## Image Assets

Ensure images referenced in `image_url` exist:

1. Place images in `frontend/apps/web/public/actions/`
2. Use web-friendly formats (JPG, PNG, WebP)
3. Optimize for web (< 200KB recommended)
4. Use descriptive filenames (`dinner.jpg`, `movie_night.jpg`)

## Best Practices

- **Personalization:** Reference user's context and preferences
- **Achievable:** Suggest realistic, actionable items
- **Positive tone:** Encouraging and supportive language
- **Visual appeal:** Use engaging, relevant images
- **Proper tagging:** Consistent tag taxonomy for filtering

## Troubleshooting

### Issue: "Failed to parse tags"

**Solution:** Ensure tags are in format `['Tag1', 'Tag2']` with single quotes inside double quotes.

### Issue: "Image not found"

**Solution:** Verify image exists at the specified path in frontend public assets.

### Issue: "Foreign key violation on thread_id"

**Solution:** Import threads before actions.

## Next Steps

1. Design your action taxonomy (categories and tags)
2. Create action titles and descriptions
3. Prepare or source action images
4. Format tags correctly
5. Link actions to appropriate threads and users
6. Import and verify actions display correctly
