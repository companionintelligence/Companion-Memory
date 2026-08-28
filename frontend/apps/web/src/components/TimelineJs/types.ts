export interface TimelineDateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second?: string;
}

export interface TimelineSlide {
  start_date: TimelineDateParts;
  end_date?: TimelineDateParts;
  text: { headline: string; text: string };
  media?: { url: string; link?: string; caption?: string };
  group?: string;
  unique_id: string;
  autolink?: boolean;
}

export interface TimelineEra {
  start_date: TimelineDateParts;
  end_date: TimelineDateParts;
  text: { headline: string };
}

export interface TimelineJsData {
  title: TimelineSlide;
  events: TimelineSlide[];
  eras?: TimelineEra[];
  scale: 'human';
}
