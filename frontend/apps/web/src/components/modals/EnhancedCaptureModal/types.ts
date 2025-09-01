import { ComponentType } from 'react';

export type CaptureCategory = 
  | 'documents' 
  | 'meetings' 
  | 'fridge' 
  | 'drawers' 
  | 'cabinets' 
  | 'shelves';

export interface CategoryConfig {
  id: CaptureCategory;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  captureInstructions: string;
  suggestedPrompts: string[];
}