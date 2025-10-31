import type { FeedItem } from './types';

// Action and Insight cards (no images)
export const actionInsightData: FeedItem[] = [
  {
    id: 'anniversary-action',
    title: 'Anniversary Planning',
    description: (
      <div className="flex flex-col gap-3 min-h-64">
        <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span className="px-2 py-0.5 rounded bg-muted">from your memory</span>
          <span className="px-2 py-0.5 rounded bg-muted">relationships • browsing • places</span>
        </div>
        <p className="text-base text-foreground">
          Your anniversary is coming up. You and <strong>{'Sarah Smith'}</strong> most often dine at{' '}
          <strong>Carmine's Italian</strong>,<strong> The Willow Bistro</strong>, and{' '}
          <strong>El Camino Taqueria</strong>. I can book a table at your favorite, or suggest top-rated
          Mexican options within 25 miles—since they love Mexican.
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-base text-muted-foreground">
          <li>
            Book a 7:30 PM reservation at <strong>Carmine's Italian</strong> this weekend
          </li>
          <li>Compare availability and reviews for top Mexican spots nearby</li>
          <li>Text your babysitter to confirm availability for the night</li>
        </ul>
      </div>
    ),
    tags: ['Anniversary', 'Reservations', 'Planner'],
  },
  {
    id: 'miami-trip-planner',
    title: 'Travel Coordination',
    description: (
      <div className="flex flex-col gap-3 min-h-64">
        <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span className="px-2 py-0.5 rounded bg-muted">from your memory</span>
          <span className="px-2 py-0.5 rounded bg-muted">events • people • locations</span>
        </div>
        <p className="text-base text-foreground">
          I noticed a flight to Miami in two weeks. Your friends in Miami include <strong>Ana</strong>,{' '}
          <strong>Marco</strong>, and
          <strong> Dev</strong>. Would you like me to send a warm note to them, or plan a short itinerary
          while you’re there?
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-base text-muted-foreground">
          <li>Draft an email to friends in Miami to coordinate a meetup</li>
          <li>Plan 3 fun activities around your hotel’s location and schedule</li>
          <li>Block travel buffer time on your calendar</li>
        </ul>
      </div>
    ),
    tags: ['Travel', 'Friends', 'Planner'],
  },
  {
    id: 'smart-followups',
    title: 'Dive Deeper on Interests',
    description: (
      <div className="flex flex-col gap-3 min-h-64">
        <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span className="px-2 py-0.5 rounded bg-muted">from your memory</span>
          <span className="px-2 py-0.5 rounded bg-muted">conversations • browsing • documents</span>
        </div>
        <p className="text-base text-foreground">
          Here are high-impact follow‑ups based on your recent browser activity and reading. Your recent
          YouTube watch history shows an interest in <strong>machine learning for product analytics</strong>,
          so I compiled a focused reading list on that topic.
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-base text-muted-foreground">
          <li>
            Curated reading list from your recent articles and YouTube history: <strong>Product ML</strong>,
            <strong> experimentation</strong>, and <strong>growth analytics</strong>
          </li>
          <li>
            A new file has been saved locally with a summary of your Google Drive activity from the last two
            weeks related to work. I’ve summarized progress and highlighted next-step opportunities for the
            upcoming two weeks.
          </li>
        </ul>
      </div>
    ),
    tags: ['Productivity', 'Assistant', 'Summaries'],
  },
  {
    id: 'kids-experiences',
    title: "Kids' Hobbies",
    description: (
      <div className="flex flex-col gap-3 min-h-64">
        <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span className="px-2 py-0.5 rounded bg-muted">from your memory</span>
          <span className="px-2 py-0.5 rounded bg-muted">interests • chats • local events</span>
        </div>
        <p className="text-base text-foreground">
          From recent chats, your kids have been enjoying cooking activities. I researched nearby activities
          they might love and put together a few options:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-base text-muted-foreground">
          <li>
            Weekend cooking class at <strong>Little Chefs Studio</strong> (ages 7–12), plus a family-friendly
            recipe pack
          </li>
          <li>
            Summer camps short‑list based on interests (cooking, art, soccer) with registration deadlines
          </li>
          <li>Library maker‑space sessions near you; I can reserve spots and add to the family calendar</li>
        </ul>
      </div>
    ),
    tags: ['Family', 'Activities', 'Planner'],
  },
  {
    id: 'home-upkeep',
    title: 'Home & Car Upkeep',
    description: (
      <div className="flex flex-col gap-3 min-h-64">
        <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span className="px-2 py-0.5 rounded bg-muted">vehicles • home • schedules</span>
        </div>
        <p className="text-base text-foreground">
          Quick maintenance wins to keep things running smoothly at home and on the road:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-base text-muted-foreground">
          <li>
            Oil change due soon for your <strong>Honda Accord</strong> (last service ~4,900 miles ago). I can
            book with your usual shop
          </li>
          <li>
            Gutter cleaning recommended before the next rain—two providers have availability this week; want
            me to compare quotes?
          </li>
          <li>
            Replace HVAC filter (3 months elapsed); I can order the correct size and set a recurring reminder
          </li>
        </ul>
      </div>
    ),
    tags: ['Maintenance', 'Home', 'Vehicle'],
  },
];
