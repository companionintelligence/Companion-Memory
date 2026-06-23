export enum PgErrorCode {
  UNIQUE_VIOLATION = '23505', // duplicate key violates unique constraint
  FOREIGN_KEY_VIOLATION = '23503', // insert/update violates foreign key
  NOT_NULL_VIOLATION = '23502', // null value in column violates not-null constraint
  CHECK_VIOLATION = '23514', // check constraint violation
  EXCLUSION_VIOLATION = '23P01', // exclusion constraint violation
  INVALID_TEXT_REPRESENTATION = '22P02', // invalid input syntax for type
  STRING_DATA_RIGHT_TRUNCATION = '22001', // value too long for type
  DEADLOCK_DETECTED = '40P01', // deadlock detected
  SERIALIZATION_FAILURE = '40001', // could not serialize access due to concurrent update
  LOCK_NOT_AVAILABLE = '55P03', // could not obtain lock on resource
  INVALID_FOREIGN_KEY = '42830', // invalid foreign key
  RESTRICT_VIOLATION = '23001', // restrict constraint violation
  INSUFFICIENT_PRIVILEGE = '42501', // insufficient_privilege
  SYNTAX_ERROR = '42601', // syntax error
  INVALID_COLUMN_REFERENCE = '42P10', // invalid column reference
  UNDEFINED_TABLE = '42P01', // undefined table
  UNDEFINED_COLUMN = '42703', // undefined column
  UNIQUE_NO_INDEX = '42P07', // relation already exists
}

/**
 * True when an error is a Postgres unique-constraint violation (23505). TypeORM
 * surfaces the pg error code either directly on the thrown error or on its nested
 * `driverError`; this checks both so callers can detect a lost insert race
 * against a (partial) unique index and fall back to find-or-return.
 */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code;
  const driverCode = (err as { driverError?: { code?: string } })?.driverError?.code;

  return code === PgErrorCode.UNIQUE_VIOLATION || driverCode === PgErrorCode.UNIQUE_VIOLATION;
}

export enum ContentType {
  PHOTO = 'Photo',
  VIDEO = 'Video',
  AUDIO = 'Audio',
  TEXT = 'Text',
  CODE = 'Code',
  GAME = 'Game',
  WEBPAGE = 'Web Page',
  FILE = 'File',
}

export enum EventType {
  VIEW = 'View',
  PLAY = 'Play',
  MESSAGE = 'Message',
  COMMENT = 'Comment',
  CREATE = 'Create',
  EDIT = 'Edit',
  CALL = 'Call',
  VISIT = 'Visit',
  TRAVEL = 'Travel',
  EAT = 'Eat',
  TRANSACTIONS = 'Transactions',
  SLEEP = 'Sleep',
  EXERCISE = 'Exercise',
}

export enum GeoFormatType {
  POINT = 'point',
  RADIUS = 'radius',
  TRIANGLE = 'triangle',
}

export enum ThingType {
  APPAREL = 'Apparel',
  FOOTWEAR = 'Footwear',
  ELECTRONICS = 'Electronics',
  FURNITURE = 'Furniture',
  KITCHENWARE = 'Kitchenware and Cooking Equipment',
  VEHICLES = 'Vehicles',
  BOOKS = 'Books and Magazines',
  JEWELRY = 'Jewelry and Accessories',
  PERSONALCARE = 'Personal Care',
  APPLIANCES = 'Appliances',
  SPORTING = 'Sporting and Fitness',
  TOOLS = 'Tools and Home Improvement Items',
  TOYS = 'Toys and Games',
  DECOR = 'Decorations and Home Décor',
  BEDDING = 'Bedding',
  INSTRUMENTS = 'Instruments',
  GARDENING = 'Gardening',
  OUTDOOR = 'Outdoor and Camping Gear',
  ART = 'Art',
  OFFICE = 'Office',
  PETSUPPLIES = 'Pet Supplies',
  FOOD = 'Food',
  CLEANING = 'Cleaning',
  MEDICAL = 'Medical',
  TRAVEL = 'Travel',
  COLLECTIBLES = 'Collectibles',
  EYEWEAR = 'Eyewear',
  WATCHES = 'Watches',
  PHOTOGRAPHY = 'Photography',
  ORGANIZATIONAL = 'Organizational',
}
