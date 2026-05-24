const TIMEZONE_OFFSETS: Record<string, string> = {
  // UTC/GMT
  UTC: '+00:00',
  GMT: '+00:00',

  // North America
  EST: '-05:00', // Eastern Standard Time
  EDT: '-04:00', // Eastern Daylight Time
  CST: '-06:00', // Central Standard Time
  CDT: '-05:00', // Central Daylight Time
  MST: '-07:00', // Mountain Standard Time
  MDT: '-06:00', // Mountain Daylight Time
  PST: '-08:00', // Pacific Standard Time
  PDT: '-07:00', // Pacific Daylight Time
  AKST: '-09:00', // Alaska Standard Time
  AKDT: '-08:00', // Alaska Daylight Time
  HST: '-10:00', // Hawaii Standard Time
  HAST: '-10:00', // Hawaii-Aleutian Standard Time
  HADT: '-09:00', // Hawaii-Aleutian Daylight Time
  ADT: '-03:00', // Atlantic Daylight Time
  NST: '-03:30', // Newfoundland Standard Time
  NDT: '-02:30', // Newfoundland Daylight Time

  // Europe
  WET: '+00:00', // Western European Time
  WEST: '+01:00', // Western European Summer Time
  CET: '+01:00', // Central European Time
  CEST: '+02:00', // Central European Summer Time
  EET: '+02:00', // Eastern European Time
  EEST: '+03:00', // Eastern European Summer Time
  BST: '+01:00', // British Summer Time

  // Asia
  IST: '+05:30', // India Standard Time
  PKT: '+05:00', // Pakistan Standard Time
  ICT: '+07:00', // Indochina Time
  HKT: '+08:00', // Hong Kong Time
  SGT: '+08:00', // Singapore Time
  JST: '+09:00', // Japan Standard Time
  KST: '+09:00', // Korea Standard Time
  ACST: '+09:30', // Australian Central Standard Time
  ACDT: '+10:30', // Australian Central Daylight Time
  AEST: '+10:00', // Australian Eastern Standard Time
  AEDT: '+11:00', // Australian Eastern Daylight Time
  AWST: '+08:00', // Australian Western Standard Time
  MSK: '+03:00', // Moscow Standard Time
  GST: '+04:00', // Gulf Standard Time
  AST: '+03:00', // Arabia Standard Time

  // Pacific
  NZST: '+12:00', // New Zealand Standard Time
  NZDT: '+13:00', // New Zealand Daylight Time
  FJT: '+12:00', // Fiji Time

  // South America
  ART: '-03:00', // Argentina Time
  BRT: '-03:00', // Brasília Time
  BRST: '-02:00', // Brasília Summer Time
  CLT: '-04:00', // Chile Standard Time
  CLST: '-03:00', // Chile Summer Time
  PET: '-05:00', // Peru Time
  VET: '-04:00', // Venezuelan Standard Time

  // Africa
  CAT: '+02:00', // Central Africa Time
  EAT: '+03:00', // East Africa Time
  WAT: '+01:00', // West Africa Time
  SAST: '+02:00', // South Africa Standard Time
};

export function parseDate(dateString: string): Date {
  const normalized = dateString.replace(/\s([A-Z]{3,4})$/, (_, tz) => {
    return TIMEZONE_OFFSETS[tz] ? ` ${TIMEZONE_OFFSETS[tz]}` : ' +00:00';
  });

  return new Date(normalized);
}
