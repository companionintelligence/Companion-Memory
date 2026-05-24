export type Relationship = {
  type: string;
  targetId: string;
  targetName: string;
  targetType: string;
  direction: 'outgoing' | 'incoming';
};
