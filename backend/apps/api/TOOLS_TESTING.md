/**
 * Example usage and testing of the tools system
 * 
 * To test this system:
 * 1. Make sure you have some test data in your database:
 *    - A user with some tags (preferences)
 *    - Some people associated with that user
 *    - Some person_tag relationships
 * 
 * 2. Start your server: yarn dev
 * 
 * 3. Test the function calling endpoint:
 */

// Example API calls you can make:

// 1. Test basic tool functionality
const testToolsDirectly = {
  method: 'POST',
  url: '/llm/tools/chat',
  headers: { 'Authorization': 'Bearer YOUR_JWT_TOKEN' },
  body: {
    messages: [
      {
        prompt: true,
        text: "What are my dietary preferences for dinner planning?"
      }
    ],
    enableTools: true,
    model: 'gemma3:1b' // or your preferred model
  }
};

// 2. Test dinner planning scenario
const testDinnerPlanning = {
  method: 'POST',
  url: '/llm/tools/chat',
  headers: { 'Authorization': 'Bearer YOUR_JWT_TOKEN' },
  body: {
    messages: [
      {
        prompt: false, // system message
        text: `You are a dinner planning assistant. When asked about dinner, use tools to get user preferences and family member information to make personalized recommendations.`
      },
      {
        prompt: true, // user message
        text: "Help me plan dinner for tonight. Consider everyone's preferences."
      }
    ],
    enableTools: true
  }
};

/**
 * Expected behavior:
 * 
 * 1. The LLM receives the dinner planning request
 * 2. It recognizes it needs context about preferences and family
 * 3. It calls get_user_preferences and get_family_members tools
 * 4. It receives the data and incorporates it into the response
 * 5. It suggests dinner options that work for everyone
 * 
 * Example flow:
 * User: "Help me plan dinner for tonight"
 * LLM: *calls get_user_preferences() and get_family_members(includePreferences: true)*
 * Tools return: User is vegetarian, spouse likes Italian, kid hates mushrooms
 * LLM: "Based on your preferences, here are some vegetarian Italian options that avoid mushrooms..."
 */

export const EXAMPLE_CURL_COMMANDS = `
# Test user preferences tool
curl -X POST http://localhost:3000/llm/tools/chat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \\
  -d '{
    "messages": [
      {
        "prompt": true,
        "text": "What dietary restrictions should I consider for dinner planning?"
      }
    ],
    "enableTools": true
  }'

# Test family dinner planning
curl -X POST http://localhost:3000/llm/tools/chat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \\
  -d '{
    "messages": [
      {
        "prompt": false,
        "text": "You help plan family dinners. Use available tools to get preferences and suggest meals everyone will enjoy."
      },
      {
        "prompt": true,
        "text": "Plan a family dinner for tonight that works for everyone"
      }
    ],
    "enableTools": true
  }'
`;
