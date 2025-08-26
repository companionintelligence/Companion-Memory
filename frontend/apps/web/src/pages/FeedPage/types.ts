export interface FeedItem {
  id: string;
  title: string;
  description: React.ReactNode;
  tags: string[];
  imageUrl?: string;
}
