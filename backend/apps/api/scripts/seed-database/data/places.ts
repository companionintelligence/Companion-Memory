import { type CreatePlaceDto } from '@ci/domains/memory/types';

type SeedPlace = RequiredFields<CreatePlaceDto, 'id'>;

// ==========================================
// RESIDENCE & SCHOOLS
// ==========================================

export const SMITH_FAMILY_HOME: SeedPlace = {
  id: 'e0c01c9a-9d7a-44cb-a5a7-23fc3b181299',
  name: 'Smith Family Home',
  description: "Our primary residence in the hills of Laguna Beach, offering the 'sanctuary' Sarah needs.",
  properties: {
    type: 'Residence',
    latitude: 33.53083080367612,
    longitude: -117.75757100320266,
    address: '1685 Del Mar Ave, Laguna Beach, CA 92651', // Near Moulton Meadows Park
    bedrooms: 4,
    neighborhood: 'Top of the World',
  },
};

export const TOP_OF_THE_WORLD_ELEMENTARY: SeedPlace = {
  id: '7095f378-af5e-4847-b5f6-2843edf6b910',
  name: 'Top of the World Elementary',
  description:
    "My son Lucas's school. It sits at the top of a steep hill, fitting our family's hiking/outdoor aesthetic.",
  properties: {
    type: 'School',
    latitude: 33.54647853153981,
    longitude: -117.75250785902539,
    address: '21601 Treetop Ln, Laguna Beach, CA 92651',
  },
};

export const LAGUNA_BEACH_HIGH_SCHOOL: SeedPlace = {
  id: 'efb30280-866b-4190-a368-2e4b5d1c838f',
  name: 'Laguna Beach High School',
  description:
    "Emma's school. Central to town, allowing her to walk to art galleries and coffee shops after class.",
  properties: {
    type: 'School',
    latitude: 33.54192593528203,
    longitude: -117.77565148192629,
    address: '625 Park Ave, Laguna Beach, CA 92651',
  },
};

// ==========================================
// WORKPLACES
// ==========================================

export const TECHNOVA_SYSTEMS_HQ: SeedPlace = {
  id: 'ecd5649f-f088-4f0d-af3b-f2bcedb0dfda',
  name: 'TechNova Systems HQ',
  description: "The tech campus in Irvine where I work. It's a 25-minute drive via Laguna Canyon Rd.",
  properties: {
    type: 'Office',
    latitude: 33.646924326575075,
    longitude: -117.85449464110788,
    address: '100 Innovation Dr, Irvine, CA 92617', // Generic Tech Hub address
  },
};

export const CREATIVE_PULSE_AGENCY: SeedPlace = {
  id: '0aa09d7e-d0d2-4cbb-aeae-f279e0ab0a56',
  name: 'Creative Pulse Agency',
  description: "Sarah's marketing firm located in the upscale Newport Center area.",
  properties: {
    type: 'Office',
    latitude: 33.61959407918107,
    longitude: -117.87750356397606,
    address: '700 Newport Center Dr, Newport Beach, CA 92660',
  },
};

// ==========================================
// JOHN'S LIFESTYLE (Action, Cycling, Coffee)
// ==========================================

export const LAGUNA_BEACH_CYCLERY: SeedPlace = {
  id: '59b893bc-586e-45e7-b3a3-627534c538d6',
  name: 'Laguna Beach Cyclery',
  description: 'My preferred bike shop for maintenance and gear.',
  properties: {
    type: 'Retail',
    latitude: 33.567912462125854,
    longitude: -117.71455347683693,
    address: '27190 Alicia Pkwy, Laguna Niguel, CA 92677',
  },
};

export const CRYSTAL_COVE_TRAILHEAD: SeedPlace = {
  id: '03660ea0-644a-4b53-ab1c-adb9e63a9777',
  name: 'El Moro Canyon Trailhead',
  description: 'The starting point for my endurance hikes and our family weekend treks.',
  properties: {
    type: 'Park',
    latitude: 33.56445767445136,
    longitude: -117.82225512647449,
    address: '8471 N Coast Hwy, Laguna Beach, CA 92651',
  },
};

export const ZINC_CAFE: SeedPlace = {
  id: 'a61ffa55-a35c-4002-a191-6092ea8b09f8',
  name: 'Zinc Cafe & Market',
  description: 'My spot for a precise, high-quality espresso.',
  properties: {
    type: 'Cafe',
    latitude: 33.5447445037388,
    longitude: -117.78281189829383,
    address: '350 Ocean Ave, Laguna Beach, CA 92651',
  },
};

export const THE_SHAKE_SHACK: SeedPlace = {
  id: 'e5f072a8-3348-4a26-9319-3e10f4023bc3',
  name: 'The Shake Shack (Crystal Cove)',
  description: 'A mid-ride stop for me during my long coastal cycling sessions.',
  properties: {
    type: 'Restaurant',
    latitude: 33.57395764966188,
    longitude: -117.83946801588222,
    address: '7703 E Coast Hwy, Newport Coast, CA 92657',
  },
};

export const GANAHL_LUMBER: SeedPlace = {
  id: '4e245500-43ce-4801-b2e3-c2aeb2122026',
  name: 'Ganahl Lumber',
  description: 'Where I go to get supplies to fix things around the house.',
  properties: {
    type: 'Retail',
    latitude: 33.55643993580424,
    longitude: -117.77384779845296,
    address: '1765 Laguna Canyon Rd, Laguna Beach, CA 92651',
  },
};

// ==========================================
// SARAH'S LIFESTYLE (Sanctuary, Art, Wellness)
// ==========================================

export const YOGA_SAPIEN: SeedPlace = {
  id: 'f89b2145-bc0b-42dd-a34d-46b26f597a11',
  name: 'Yoga Sapien',
  description: "Sarah's sanctuary studio for her practice.",
  properties: {
    type: 'Gym',
    latitude: 33.544756812072634,
    longitude: -117.78394423948184,
    address: '312 Broadway St, Laguna Beach, CA 92651',
  },
};

export const LAGUNA_BEACH_BOOKS: SeedPlace = {
  id: '636d76b4-900a-4809-8ccd-9c4ed847d5c6',
  name: 'Laguna Beach Books',
  description: "Sarah's favorite quiet spot to browse literature.",
  properties: {
    type: 'Retail',
    latitude: 33.53333272639711,
    longitude: -117.77599538694415,
    address: '1200 S Coast Hwy, Laguna Beach, CA 92651',
  },
};

export const ROGERS_GARDENS: SeedPlace = {
  id: 'a7dbbfaf-4e82-44d1-97c3-1bb0d0739c4f',
  name: "Roger's Gardens",
  description: "A massive garden center in Corona Del Mar where Sarah finds plants for her 'sanctuary'.",
  properties: {
    type: 'Retail',
    latitude: 33.6124424553089,
    longitude: -117.86623407786914,
    address: '2301 San Joaquin Hills Rd, Corona Del Mar, CA 92625',
  },
};

export const MONTAGE_SPA: SeedPlace = {
  id: '934aa659-ebe7-4b54-bd30-f9d942a02f67',
  name: 'Spa Montage',
  description: "The luxury retreat Sarah visits when she needs deep 'co-regulation' time.",
  properties: {
    type: 'Spa',
    latitude: 33.5304774024521,
    longitude: -117.77405608246116,
    address: '1555 S Coast Hwy, Laguna Beach, CA 92651',
  },
};

// ==========================================
// EMMA'S LIFESTYLE (Art, Conscience, Vintage)
// ==========================================

export const SOUND_SPECTRUM: SeedPlace = {
  id: 'f69d89b2-9fde-4bdc-ad29-b51126e1c9b6',
  name: 'Sound Spectrum',
  description: 'A vintage record store where Emma browses for vinyl.',
  properties: {
    type: 'Retail',
    latitude: 33.532877805179254,
    longitude: -117.77589211355867,
    address: '1264 S Coast Hwy, Laguna Beach, CA 92651',
  },
};

export const ART_SUPPLY_WAREHOUSE: SeedPlace = {
  id: 'a9fdf4e9-94cd-46ee-9e9c-ad75b0b96f2a',
  name: 'Laguna Art Supply',
  description: 'Where Emma buys her charcoal and sketchbooks.',
  properties: {
    type: 'Retail',
    latitude: 33.54512689706429,
    longitude: -117.78251470261843,
    address: '376 Ocean Ave, Laguna Beach, CA 92651',
  },
};

export const LAGUNA_ART_MUSEUM: SeedPlace = {
  id: '387398d1-1215-4187-9cb8-aaba9f8501cf',
  name: 'Laguna Art Museum',
  description: 'A frequent haunt for Emma and Sarah.',
  properties: {
    type: 'Museum',
    latitude: 33.54350839690638,
    longitude: -117.78821091795459,
    address: '307 Cliff Dr, Laguna Beach, CA 92651',
  },
};

export const SAWDUST_FESTIVAL: SeedPlace = {
  id: 'c9fa0057-9eaa-4dfc-a4d2-c0d2f4cffa90',
  name: 'Sawdust Art Festival',
  description: 'Local art festival grounds where we visit in the summer.',
  properties: {
    type: 'Event Venue',
    latitude: 33.55062152553787,
    longitude: -117.77878828529465,
    address: '935 Laguna Canyon Rd, Laguna Beach, CA 92651',
  },
};

export const URTH_CAFFE: SeedPlace = {
  id: 'e8e93320-9e8e-473f-9397-f23064e00592',
  name: 'Urth Caffé',
  description: "Emma's preferred spot to hang out with friends.",
  properties: {
    type: 'Cafe',
    latitude: 33.54419001385287,
    longitude: -117.78837332230843,
    address: '308 N Coast Hwy, Laguna Beach, CA 92651',
  },
};

// ==========================================
// LUCAS'S LIFESTYLE (Joy, Play, Outdoors)
// ==========================================

export const ALTA_LAGUNA_PARK: SeedPlace = {
  id: 'd6c5575f-d1de-4720-836d-a27454817034',
  name: 'Alta Laguna Park',
  description: "Lucas's territory: baseball fields, soccer, and rocky trails.",
  properties: {
    type: 'Park',
    latitude: 33.555894096200426,
    longitude: -117.7582437073905,
    address: '3300 Alta Laguna Blvd, Laguna Beach, CA 92651',
  },
};

export const GELATO_PARADISO: SeedPlace = {
  id: '839c79f4-416d-4c4f-8420-090d3181ff71',
  name: 'Gelato Paradiso',
  description: 'Our post-soccer treat spot located in a hidden alley.',
  properties: {
    type: 'Restaurant',
    latitude: 33.54136394320071,
    longitude: -117.7822112487587,
    address: '448 S Coast Hwy Ste A, Laguna Beach, CA 92651',
  },
};

export const MOULTON_MEADOWS_PARK: SeedPlace = {
  id: '6764a70b-3d0f-42dd-89a6-26c7ec54ec54',
  name: 'Moulton Meadows Park',
  description: 'A park near our home where Lucas and I kick the soccer ball.',
  properties: {
    type: 'Park',
    latitude: 33.5294525384074,
    longitude: -117.75403475711002,
    address: 'Balboa Ave & Capistrano Ave, Laguna Beach, CA 92651',
  },
};

export const HOBIE_SURF_SHOP: SeedPlace = {
  id: '35f0a7be-64f0-4714-afa6-438c15eb8ff3',
  name: 'Hobie Surf Shop',
  description: 'Where Lucas gets his beach gear.',
  properties: {
    type: 'Retail',
    latitude: 33.54351170231824,
    longitude: -117.7825506390141,
    address: '294 Forest Ave, Laguna Beach, CA 92651',
  },
};

// ==========================================
// FAMILY & DINING
// ==========================================

export const NICKS_LAGUNA_BEACH: SeedPlace = {
  id: '30a10ee6-27e4-4ccf-b5b5-92c40264a898',
  name: "Nick's Laguna Beach",
  description: 'A great date night spot for Sarah and me.',
  properties: {
    type: 'Restaurant',
    latitude: 33.54136462757387,
    longitude: -117.78237271087042,
    address: '440 S Coast Hwy, Laguna Beach, CA 92651',
  },
};

export const ACTIVE_CULTURE: SeedPlace = {
  id: 'cc3b9523-8043-486e-92f2-9af1cb61b1aa',
  name: 'Active Culture',
  description: 'A family favorite for healthy, quick bowls and shakes.',
  properties: {
    type: 'Restaurant',
    latitude: 33.5342,
    longitude: -117.7758,
    address: '1006 S Coast Hwy, Laguna Beach, CA 92651',
  },
};

export const TRADER_JOES_CRYSTAL_COVE: SeedPlace = {
  id: 'c1139fb5-b14b-49ae-adf4-9bfeae29e376',
  name: "Trader Joe's (Crystal Cove)",
  description: 'The primary grocery store for our household.',
  properties: {
    type: 'Retail',
    latitude: 33.534995674448304,
    longitude: -117.77733303058632,
    address: '8086 E Coast Hwy, Newport Coast, CA 92657',
  },
};

export const MISSION_HOSPITAL: SeedPlace = {
  id: 'd4b4995d-5b61-400c-931f-b757c9c9a54f',
  name: 'Mission Hospital Laguna Beach',
  description: 'The local medical center.',
  properties: {
    type: 'Medical',
    latitude: 33.500691781343065,
    longitude: -117.7408216922935,
    address: '31872 Coast Hwy, Laguna Beach, CA 92651',
  },
};

export const MAIN_BEACH_PARK: SeedPlace = {
  id: '48d909ce-9a22-43e1-9a0b-e059cb4a3015',
  name: 'Main Beach Park',
  description: 'The iconic boardwalk and beach area where we walk on weekends.',
  properties: {
    type: 'Park',
    latitude: 33.542734802275014,
    longitude: -117.78535777474306,
    address: 'Broadway & Pacific Coast Hwy, Laguna Beach, CA 92651',
  },
};

export const LAGUNA_PLAYHOUSE: SeedPlace = {
  id: '9ac9956c-f1a0-4cb9-b04f-fa84e45dc736',
  name: 'Laguna Playhouse',
  description: 'Local theater where Emma sometimes sees plays.',
  properties: {
    type: 'Theater',
    latitude: 33.54735837222742,
    longitude: -117.782506253608,
    address: '606 Laguna Canyon Rd, Laguna Beach, CA 92651',
  },
};

// ==========================================
// OTHER / PROFESSIONAL
// ==========================================

export const JOHN_WAYNE_AIRPORT: SeedPlace = {
  id: 'a6f4f585-92c2-47f0-883b-2e9935acce2b',
  name: 'John Wayne Airport (SNA)',
  description: 'The airport used for my business travel.',
  properties: {
    type: 'Airport',
    latitude: 33.674668337152845,
    longitude: -117.86924463471968,
    address: '18601 Airport Way, Santa Ana, CA 92707',
  },
};

export const ANAHEIM_CONVENTION_CENTER: SeedPlace = {
  id: '1e4f4973-5656-4cb0-b77f-0f333cb434fd',
  name: 'Anaheim Convention Center',
  description: 'Where I attend tech conferences.',
  properties: {
    type: 'Conference Center',
    latitude: 33.80251949473581,
    longitude: -117.91849644313915,
    address: '800 W Katella Ave, Anaheim, CA 92802',
  },
};

export const CINEPOLIS_LUXURY_CINEMAS: SeedPlace = {
  id: 'a729d728-8341-454f-be82-ef4ce8a3196f',
  name: 'Cinépolis Luxury Cinemas',
  description: 'A luxury movie theater for our family outings in Laguna Niguel.',
  properties: {
    type: 'Cinema',
    latitude: 33.492069109822815,
    longitude: -117.69812706722749,
    address: '32401 Golden Lantern, Laguna Niguel, CA 92677',
  },
};

export const VICTORIA_BEACH: SeedPlace = {
  id: 'ad4230e0-ca30-4dde-bb79-e2f1ba3399fe',
  name: 'Victoria Beach',
  description: "A quieter beach near the 'Pirate Tower' that Emma prefers.",
  properties: {
    type: 'Park',
    latitude: 33.51958975616742,
    longitude: -117.7628117421706,
    address: '2700 Victoria Dr, Laguna Beach, CA 92651',
  },
};

export const PLACES: SeedPlace[] = [
  SMITH_FAMILY_HOME,
  TOP_OF_THE_WORLD_ELEMENTARY,
  LAGUNA_BEACH_HIGH_SCHOOL,
  TECHNOVA_SYSTEMS_HQ,
  CREATIVE_PULSE_AGENCY,
  LAGUNA_BEACH_CYCLERY,
  CRYSTAL_COVE_TRAILHEAD,
  ZINC_CAFE,
  THE_SHAKE_SHACK,
  GANAHL_LUMBER,
  YOGA_SAPIEN,
  LAGUNA_BEACH_BOOKS,
  ROGERS_GARDENS,
  MONTAGE_SPA,
  SOUND_SPECTRUM,
  ART_SUPPLY_WAREHOUSE,
  LAGUNA_ART_MUSEUM,
  SAWDUST_FESTIVAL,
  URTH_CAFFE,
  ALTA_LAGUNA_PARK,
  GELATO_PARADISO,
  MOULTON_MEADOWS_PARK,
  HOBIE_SURF_SHOP,
  NICKS_LAGUNA_BEACH,
  ACTIVE_CULTURE,
  TRADER_JOES_CRYSTAL_COVE,
  MISSION_HOSPITAL,
  MAIN_BEACH_PARK,
  LAGUNA_PLAYHOUSE,
  JOHN_WAYNE_AIRPORT,
  ANAHEIM_CONVENTION_CENTER,
  CINEPOLIS_LUXURY_CINEMAS,
  VICTORIA_BEACH,
];
