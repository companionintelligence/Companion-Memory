import type { DocumentDetail } from '@/api/powersync/localSearch';
import { formatEntityLabel, formatEntityTimestamp } from '@/components/EntityFields';
import type { DateTimeFormatter } from '@/lib/dateTimeFormat';
import { formatBytes } from '@/pages/MemoryPage/Components';

/** What the record page calls each type. */
export const RECORD_TYPE_LABELS: Record<string, string> = {
  communication: 'Message',
  concept: 'Concept',
  content: 'Content',
  event: 'Event',
  file: 'File',
  item: 'Thing',
  note: 'Note',
  person: 'Person',
  place: 'Place',
  product: 'Product',
  receipt: 'Receipt',
  task: 'Task',
  thread: 'Chat',
};

export function recordTypeLabel(entityType: string): string {
  return RECORD_TYPE_LABELS[entityType] ?? formatEntityLabel(entityType) ?? entityType;
}

/**
 * The `detail` keys the page shows, with their labels, in this order. Keys
 * absent here are ids and bookkeeping (the person and place ids the filters
 * use, the truncation flag) and are not shown; a key the server adds later
 * shows with its name made readable, so a new field needs no change here.
 */
const DETAIL_LABELS: Array<[key: string, label: string]> = [
  ['communication_type', 'Kind'],
  ['direction', 'Direction'],
  ['participants', 'Participants'],
  ['event_type', 'Kind'],
  ['category', 'Category'],
  ['status', 'Status'],
  ['end_time', 'Ends'],
  ['is_all_day', 'All day'],
  ['location_name', 'Where'],
  ['type', 'Kind'],
  ['mimetype', 'Format'],
  ['content_type', 'Format'],
  ['size', 'Size'],
  ['width', 'Dimensions'],
  ['source_url', 'Link'],
  ['first_name', 'First name'],
  ['last_name', 'Last name'],
  ['is_self', 'This is you'],
  ['place_kind', 'Kind'],
  ['merchant_name', 'Merchant'],
  ['total_minor', 'Total'],
  ['brand', 'Brand'],
  ['model', 'Model'],
  ['model_number', 'Model number'],
  ['priority', 'Priority'],
  ['due_at', 'Due'],
  ['scheduled_for', 'Scheduled'],
  ['completed_at', 'Completed'],
  ['last_message_at', 'Last message'],
  ['lat', 'Coordinates'],
  ['source_system', 'Source'],
];

const HIDDEN_KEYS = new Set([
  'from_id',
  'to_ids',
  'people',
  'location_id',
  'participants_truncated',
  'lng',
  'height',
  'currency',
]);
const TIMESTAMP_KEYS = new Set(['end_time', 'due_at', 'scheduled_for', 'completed_at', 'last_message_at']);

export interface DetailRow {
  key: string;
  label: string;
  value: string;
}

function names(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(', ');
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A record's `detail` as labelled rows for the page. Field-specific
 * renderings: participants as "From … · To …", a size in bytes as KB/MB,
 * a receipt's total in minor units with its currency, coordinates as one
 * pair, timestamps through the app's formatter, booleans as Yes/No.
 */
export function detailRows(detail: DocumentDetail | null, fmt: DateTimeFormatter): DetailRow[] {
  if (!detail) {
    return [];
  }

  const rows: DetailRow[] = [];
  const seen = new Set<string>();

  const push = (key: string, label: string, value: string | null) => {
    if (value != null && value !== '') {
      rows.push({ key, label, value });
    }
  };

  for (const [key, label] of DETAIL_LABELS) {
    seen.add(key);

    if (!(key in detail) || detail[key] == null) {
      continue;
    }

    const value = detail[key];

    switch (key) {
      case 'participants': {
        const participants = value as { from?: unknown; to?: unknown };
        const parts = [
          participants.from ? `From ${names(participants.from)}` : null,
          participants.to ? `To ${names(participants.to)}` : null,
        ].filter(Boolean);

        if (detail.participants_truncated) {
          parts.push('and more');
        }

        push(key, label, parts.join(' · '));
        break;
      }

      case 'size':
        push(key, label, typeof value === 'number' ? formatBytes(value, 1) : String(value));
        break;

      case 'width':
        push(key, label, detail.height != null ? `${value} × ${detail.height}` : String(value));
        break;

      case 'total_minor': {
        const amount = typeof value === 'number' ? (value / 100).toFixed(2) : String(value);

        push(key, label, detail.currency ? `${amount} ${detail.currency}` : amount);
        break;
      }

      case 'lat':
        push(
          key,
          label,
          detail.lng != null
            ? `${Number(value).toFixed(4)}, ${Number(detail.lng).toFixed(4)}`
            : String(value),
        );
        break;

      case 'is_all_day':
      case 'is_self':
        push(key, label, value ? 'Yes' : 'No');
        break;

      case 'source_url':
        push(key, label, String(value));
        break;

      default:
        if (TIMESTAMP_KEYS.has(key)) {
          push(key, label, formatEntityTimestamp(String(value), fmt));
        } else if (typeof value === 'boolean') {
          push(key, label, value ? 'Yes' : 'No');
        } else {
          push(key, label, formatEntityLabel(String(value)) ?? String(value));
        }
    }
  }

  // Anything the server added since this list was written.
  for (const [key, value] of Object.entries(detail)) {
    if (!seen.has(key) && !HIDDEN_KEYS.has(key) && value != null) {
      push(
        key,
        formatEntityLabel(key) ?? key,
        typeof value === 'object' ? JSON.stringify(value) : String(value),
      );
    }
  }

  return rows;
}
