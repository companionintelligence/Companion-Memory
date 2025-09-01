import { 
  FileText, 
  Users, 
  ChefHat, 
  FolderOpen, 
  Archive, 
  Package 
} from '@ci/shadcn/icons';
import type { CategoryConfig, CaptureCategory } from './types';

export const CAPTURE_CATEGORIES: Record<CaptureCategory, CategoryConfig> = {
  documents: {
    id: 'documents',
    label: 'Documents',
    description: 'Capture receipts, contracts, forms, and written materials',
    icon: FileText,
    captureInstructions: 'Position document clearly in frame with good lighting. Ensure text is readable.',
    suggestedPrompts: [
      'Extract text from this document',
      'Summarize the key points',
      'What type of document is this?',
      'Are there any important dates or deadlines?'
    ]
  },
  meetings: {
    id: 'meetings',
    label: 'Meetings',
    description: 'Record meeting discussions and capture whiteboard content',
    icon: Users,
    captureInstructions: 'Capture whiteboard content or record meeting audio/video. Ensure good audio quality.',
    suggestedPrompts: [
      'Summarize the key discussion points',
      'What decisions were made?',
      'List any action items',
      'Who are the participants?'
    ]
  },
  fridge: {
    id: 'fridge',
    label: 'Fridge Contents',
    description: 'Track food inventory and expiration dates',
    icon: ChefHat,
    captureInstructions: 'Capture shelves and compartments clearly. Include labels and expiration dates.',
    suggestedPrompts: [
      'What food items do I have?',
      'What expires soon?',
      'Suggest recipes with these ingredients',
      'Create a shopping list for missing items'
    ]
  },
  drawers: {
    id: 'drawers',
    label: 'Drawers',
    description: 'Organize and inventory drawer contents',
    icon: FolderOpen,
    captureInstructions: 'Open drawer fully and capture contents with clear lighting.',
    suggestedPrompts: [
      'What items are in this drawer?',
      'How is this drawer organized?',
      'Suggest better organization',
      'What items might be missing?'
    ]
  },
  cabinets: {
    id: 'cabinets',
    label: 'Cabinets',
    description: 'Catalog cabinet organization and supplies',
    icon: Archive,
    captureInstructions: 'Capture each shelf level separately for better detail.',
    suggestedPrompts: [
      'Inventory the cabinet contents',
      'Suggest organization improvements',
      'What supplies need restocking?',
      'Group similar items together'
    ]
  },
  shelves: {
    id: 'shelves',
    label: 'Shelves',
    description: 'Document shelf organization and collections',
    icon: Package,
    captureInstructions: 'Capture from multiple angles if shelves are deep.',
    suggestedPrompts: [
      'What is stored on these shelves?',
      'How can I better organize this?',
      'Create an inventory list',
      'Identify items that are rarely used'
    ]
  }
};