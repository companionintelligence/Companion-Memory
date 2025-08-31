import { GoogleInstructions } from './GoogleInstructions';
import { MetaInstructions } from './MetaInstructions';
import { MicrosoftInstructions } from './MicrosoftInstructions';
import { SpotifyInstructions } from './SpotifyInstructions';
import { AppleInstructions } from './AppleInstructions';

export { GoogleInstructions } from './GoogleInstructions';
export { MetaInstructions } from './MetaInstructions';
export { MicrosoftInstructions } from './MicrosoftInstructions';
export { SpotifyInstructions } from './SpotifyInstructions';
export { AppleInstructions } from './AppleInstructions';

// Platform instruction mapper for easy access
export const PlatformInstructions = {
  google: GoogleInstructions,
  meta: MetaInstructions,
  facebook: MetaInstructions, // Alias for Meta
  microsoft: MicrosoftInstructions,
  spotify: SpotifyInstructions,
  apple: AppleInstructions,
} as const;

export type PlatformKey = keyof typeof PlatformInstructions;
