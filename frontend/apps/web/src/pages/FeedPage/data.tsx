import type { FeedItem } from './types';

export const feedData: FeedItem[] = [
  {
    id: '1',
    title: 'Anniversary Gift Ideas',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">
          Your anniversary is coming up! Here are some thoughtful gift ideas based on your preferences:
        </p>
        <ul className="text-sm space-y-1">
          <li>• Weekend getaway to that mountain cabin you mentioned</li>
          <li>• Custom photo album of your favorite memories</li>
          <li>• Cooking class for two at the local culinary school</li>
          <li>• Personalized jewelry with your anniversary date</li>
        </ul>
        <p className="text-xs text-gray-500 mt-2">Would you like me to help you plan any of these options?</p>
      </div>
    ),
    tags: ['Anniversary', 'Gift Ideas', 'Planning'],
    imageUrl: 'https://images.unsplash.com/photo-1518895949257-7621c3c786d7?w=400&h=300&fit=crop&crop=center',
  },
  {
    id: '2',
    title: 'Dinner with the Kids Tonight',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">
          Since you have dinner with the kids tonight, here are some family-friendly meal suggestions:
        </p>
        <div className="text-sm space-y-2">
          <div>
            <strong>Quick & Easy:</strong>
            <ul className="ml-4 space-y-1">
              <li>• Homemade pizza with their favorite toppings</li>
              <li>• Build-your-own taco night</li>
              <li>• Pasta with simple marinara sauce</li>
            </ul>
          </div>
          <div>
            <strong>Healthy Options:</strong>
            <ul className="ml-4 space-y-1">
              <li>• Grilled chicken with roasted vegetables</li>
              <li>• Stir-fry with rice</li>
            </ul>
          </div>
        </div>
      </div>
    ),
    tags: ['Dinner', 'Family', 'Kids', 'Meal Planning'],
    imageUrl: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400&h=300&fit=crop&crop=center',
  },
  {
    id: '3',
    title: 'Movie Night Options',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">Perfect evening for a movie! Here are your options:</p>
        <div className="text-sm space-y-3">
          <div>
            <strong className="text-blue-600">At Home:</strong>
            <ul className="ml-4 space-y-1">
              <li>• "The Princess Bride" (family classic)</li>
              <li>• "Inside Out" (great for kids)</li>
              <li>• "The Greatest Showman" (musical fun)</li>
            </ul>
          </div>
          <div>
            <strong className="text-green-600">In Theaters:</strong>
            <ul className="ml-4 space-y-1">
              <li>• "Elemental" (animated, family-friendly)</li>
              <li>• "Indiana Jones" (action adventure)</li>
              <li>• "Mission Impossible" (thriller)</li>
            </ul>
          </div>
        </div>
        <p className="text-xs text-gray-500">Showtimes available at 7:00 PM and 9:30 PM</p>
      </div>
    ),
    tags: ['Entertainment', 'Movies', 'Family Time'],
    imageUrl: 'https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?w=400&h=300&fit=crop&crop=center',
  },
  {
    id: '4',
    title: 'Weekend Activity Suggestions',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">
          Looking ahead to the weekend? Here are some activities the whole family might enjoy:
        </p>
        <div className="text-sm space-y-2">
          <div>
            <strong>Outdoor:</strong>
            <ul className="ml-4 space-y-1">
              <li>• Hiking at the local nature preserve</li>
              <li>• Bike ride along the river trail</li>
              <li>• Picnic at the park</li>
            </ul>
          </div>
          <div>
            <strong>Indoor:</strong>
            <ul className="ml-4 space-y-1">
              <li>• Board game tournament</li>
              <li>• DIY craft project</li>
              <li>• Family cooking challenge</li>
            </ul>
          </div>
        </div>
      </div>
    ),
    tags: ['Weekend', 'Activities', 'Family'],
    imageUrl: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400&h=300&fit=crop&crop=center',
  },
  {
    id: '5',
    title: 'Grocery Shopping Reminder',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">
          Based on your meal plans, here's what you might need to pick up:
        </p>
        <div className="text-sm space-y-2">
          <div>
            <strong>For Dinner Tonight:</strong>
            <ul className="ml-4 space-y-1">
              <li>• Ground beef or chicken</li>
              <li>• Fresh vegetables</li>
              <li>• Pasta or rice</li>
              <li>• Cheese for pizza</li>
            </ul>
          </div>
          <div>
            <strong>Snacks for Movie Night:</strong>
            <ul className="ml-4 space-y-1">
              <li>• Popcorn kernels</li>
              <li>• Movie theater candy</li>
              <li>• Soda or juice</li>
            </ul>
          </div>
        </div>
      </div>
    ),
    tags: ['Shopping', 'Groceries', 'Planning'],
    imageUrl: 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=400&h=300&fit=crop&crop=center',
  },
  {
    id: '6',
    title: 'Weather Update',
    description: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-gray-600">Today's weather forecast for your area:</p>
        <div className="text-sm space-y-2">
          <div className="flex justify-between">
            <span>Current:</span>
            <span className="font-semibold">72°F, Sunny</span>
          </div>
          <div className="flex justify-between">
            <span>Tonight:</span>
            <span className="font-semibold">65°F, Clear</span>
          </div>
          <div className="flex justify-between">
            <span>Tomorrow:</span>
            <span className="font-semibold">75°F, Partly Cloudy</span>
          </div>
        </div>
        <p className="text-xs text-gray-500">Perfect weather for outdoor activities this weekend!</p>
      </div>
    ),
    tags: ['Weather', 'Forecast'],
    imageUrl: 'https://images.unsplash.com/photo-1592210454359-9043f067919b?w=400&h=300&fit=crop&crop=center',
  },
];

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
    tags: ['Insights', 'Family', 'Analytics'],
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
    tags: ['Productivity', 'Analytics', 'Patterns'],
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
