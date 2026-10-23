// Moved to api/powersync/deviceFallback.ts when the rule grew past the everything
// browse (the chronology, the timeline, the map, people and the error state all
// read it now). Kept as a re-export for the existing imports and the test.
export { answersFromDevice, useAnswersFromDevice } from '@/api/powersync/deviceFallback';
