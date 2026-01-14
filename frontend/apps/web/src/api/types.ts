export interface Action {
  id: string;
  title: string;
  text: string;
  imageUrl?: string;
  threadId: string;
  tags: string[];
}

export interface File {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url?: string;
}

export interface Message {
  id: string;
  model: string;
  role: string;
  content: string;
  mimetype: string | null;
  toolCalls: object[] | null;
  canceled: boolean;
}

export interface Thread {
  id: string;
  name: string | null;
  model: string;
  description: string | null;
  messages?: Message[];
}

export interface Summary {
  id: string;
  title: string | null;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  summaryText: string;
  keyInsights: string[];
  notableEvents: string[];
  anomalies: string[];
  tags: string[];
  activityCounts: {
    total: number;
    browserActivity?: number;
    communications?: number;
    files?: number;
  };
  dailyRhythm?: string[];
  productivityPatterns?: string[];
  socialInteractions?: string[];
  keyAccomplishments?: string[];
  moodIndicators?: string[];
}
