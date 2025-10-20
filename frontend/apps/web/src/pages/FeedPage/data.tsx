import type { FeedItem } from './types';

// Action and Insight cards (no images)
export const actionInsightData: FeedItem[] = [
  {
    id: 'action-1',
    title: 'Quick Actions',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">Common tasks you might want to complete:</p>
        <div className="text-sm space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
            <span>Schedule anniversary dinner reservation</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-green-500 rounded-full"></span>
            <span>Add movie night to calendar</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-purple-500 rounded-full"></span>
            <span>Create grocery shopping list</span>
          </div>
        </div>
      </div>
    ),
    tags: ['Actions', 'Quick Tasks'],
  },
  {
    id: 'insight-1',
    title: 'Family Time Insights',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">Based on your recent activities:</p>
        <div className="text-sm space-y-2">
          <div>
            <strong>Trend:</strong> You've been spending more quality time with family
          </div>
          <div>
            <strong>Recommendation:</strong> Consider planning a monthly family outing
          </div>
          <div>
            <strong>Opportunity:</strong> Kids seem to enjoy cooking activities
          </div>
        </div>
      </div>
    ),
    tags: ['Insights', 'Family', 'Knowledge'],
  },
  {
    id: 'action-2',
    title: 'Upcoming Reminders',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">Don't forget these important dates:</p>
        <div className="text-sm space-y-2">
          <div className="flex justify-between">
            <span>Anniversary:</span>
            <span className="font-semibold text-red-600">Next Friday</span>
          </div>
          <div className="flex justify-between">
            <span>Kids' School Event:</span>
            <span className="font-semibold">Next Tuesday</span>
          </div>
          <div className="flex justify-between">
            <span>Dentist Appointment:</span>
            <span className="font-semibold">Next Thursday</span>
          </div>
        </div>
      </div>
    ),
    tags: ['Reminders', 'Calendar', 'Important'],
  },
  {
    id: 'insight-2',
    title: 'Productivity Patterns',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">Your productivity insights this week:</p>
        <div className="text-sm space-y-2">
          <div>
            <strong>Peak Hours:</strong> 9:00 AM - 11:00 AM
          </div>
          <div>
            <strong>Most Productive Day:</strong> Wednesday
          </div>
          <div>
            <strong>Focus Areas:</strong> Family planning, meal prep, entertainment
          </div>
        </div>
      </div>
    ),
    tags: ['Productivity', 'Knowledge', 'Patterns'],
  },
  {
    id: 'action-3',
    title: 'Smart Suggestions',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">AI-powered recommendations:</p>
        <div className="text-sm space-y-2">
          <div>
            <strong>Weather-based:</strong> Perfect day for outdoor activities
          </div>
          <div>
            <strong>Time-based:</strong> Consider meal prep for the week
          </div>
          <div>
            <strong>Family-based:</strong> Kids might enjoy the new park opening
          </div>
        </div>
      </div>
    ),
    tags: ['AI', 'Suggestions', 'Smart'],
  },
];
