import { type CreateItemDto } from '@ci/domains/memory/types';

export type SeedItem = RequiredFields<CreateItemDto, 'id'>;

// ==========================================
// JOHN SMITH (The Architect of Action)
// Context: Software Engineer, Cyclist, System Optimizer
// ==========================================
export const JOHN_ITEMS: SeedItem[] = [
  {
    id: '6c05f683-97c9-4ec1-904c-e6f1523efdc5',
    name: 'Tesla Model 3',
    category: 'Vehicle',
    brand: 'Tesla',
    metadata: {
      year: 2023,
      color: 'Midnight Silver',
      description: "John's primary vehicle. He tracks the battery efficiency stats obsessively.",
    },
  },
  {
    id: '20dd64a6-bf54-4aa5-914e-58ab902fc803',
    name: 'Carbon Road Bike',
    category: 'Vehicle',
    brand: 'Trek',
    metadata: {
      model: 'Émonda SL 6',
      type: 'Endurance',
      description: "Used for his weekend 'stress-processing' rides to burn off anxiety.",
    },
  },
  {
    id: 'e6b674a2-3c7a-49e4-bd91-a084495cf44c',
    name: 'High-End Workstation PC',
    category: 'Digital Device',
    brand: 'Custom Built',
    metadata: {
      gpu: 'RTX 4090',
      cpu: 'Intel i9',
      description: "The 'Engine Room'. Used for coding, systems architecture, and occasional gaming.",
    },
  },
  {
    id: 'a1378752-6061-4e99-90a3-d2fd31d4fe97',
    name: 'Home Server Rack',
    category: 'Digital Device',
    brand: 'Ubiquiti',
    metadata: {
      description: "Manages the home network, ad-blocking, and media backups. John's pride and joy.",
    },
  },
  {
    id: '3b3a2f04-1568-45e3-87bd-32a61a3c2b0c',
    name: 'Espresso Machine',
    category: 'Appliance',
    brand: 'Breville',
    metadata: {
      model: 'Dual Boiler',
      description: 'John approaches coffee extraction as a physics problem to be solved every morning.',
    },
  },
  {
    id: '71575c88-6722-4a59-99c0-e298e4f512a2',
    name: 'Smart Watch',
    category: 'Wearable',
    brand: 'Garmin',
    metadata: {
      model: 'Fenix 7',
      description: 'Tracks his heart rate variability and cycling watts with military precision.',
    },
  },
  {
    id: '43434038-b21d-4a4a-abd5-e5e46d36ef48',
    name: 'Hiking Backpack',
    category: 'Sports Equipment',
    brand: 'Osprey',
    metadata: {
      model: 'Talon 22',
      description: 'Always pre-packed with first aid and survival gear for family hikes.',
    },
  },
  {
    id: 'b41a2a29-bdc4-4a1b-919d-8651835bb325',
    name: 'Smart Standing Desk',
    category: 'Furniture',
    brand: 'Uplift',
    metadata: {
      description: 'Programmable desk that forces him to change posture to optimize health.',
    },
  },
  {
    id: '3de9a80d-1a97-4718-93fa-8473255e7937',
    name: 'Precision Tool Set',
    category: 'Tool',
    brand: 'iFixit',
    metadata: {
      description: "For repairing electronics and maintaining the family's devices.",
    },
  },
  {
    id: '20584c0c-4ffc-4123-8873-fda5d82f9aea',
    name: 'Camera Drone',
    category: 'Electronics',
    brand: 'DJI',
    metadata: {
      model: 'Mini 3 Pro',
      description: 'Used to capture aerial footage of family vacations (and check gutter health).',
    },
  },
];

// ==========================================
// SARAH SMITH (The Quiet Center)
// Context: Marketing Manager, Yoga, Reading, Sanctuary
// ==========================================
export const SARAH_ITEMS: SeedItem[] = [
  {
    id: '5a899c2e-fc86-4ff7-8b2b-c4b37582ce06',
    name: 'Family SUV',
    category: 'Vehicle',
    brand: 'Honda',
    metadata: {
      model: 'Odyssey',
      description: 'The mobile command center for school runs and soccer practice.',
    },
  },
  {
    id: '5e65f156-9aba-4419-88d7-b6d7c5d9ce46',
    name: 'Yoga Mat & Blocks',
    category: 'Sports Equipment',
    brand: 'Lululemon',
    metadata: {
      description: 'Used daily for grounding routines before the house wakes up.',
    },
  },
  {
    id: 'dc2839b0-6356-4536-9dc1-c7d83741e034',
    name: 'E-Reader',
    category: 'Digital Device',
    brand: 'Amazon',
    metadata: {
      model: 'Kindle Oasis',
      description: 'Her escape portal. Contains hundreds of literary fiction novels.',
    },
  },
  {
    id: '881ebd8e-9873-4189-b303-6f9d08ed2cf4',
    name: 'Work Laptop',
    category: 'Digital Device',
    brand: 'Apple',
    metadata: {
      model: 'MacBook Air M2',
      description: 'Sleek and portable for her Marketing management tasks.',
    },
  },
  {
    id: 'ed830d0d-e404-45e4-b901-2fad538ccfd6',
    name: 'Gardening Tool Set',
    category: 'Tool',
    metadata: {
      description: 'For tending to the backyard sanctuary and vegetable patch.',
    },
  },
  {
    id: '6099d130-db7e-4e90-9502-8f86e71c236b',
    name: 'Ceramic Tea Set',
    category: 'Kitchenware',
    metadata: {
      description: 'Hand-thrown pottery used for her evening ritual.',
    },
  },
  {
    id: '0c475a19-459b-45d3-8e9f-75ee3afaa542',
    name: 'Essential Oil Diffuser',
    category: 'Appliance',
    metadata: {
      description: "Part of the 'calm atmosphere' engineering in the living room.",
    },
  },
  {
    id: 'f7cf3a54-567f-437d-a390-6b11799ae22c',
    name: 'Meditation Cushion',
    category: 'Furniture',
    metadata: {
      description: 'A Zafu cushion where she practices mindfulness.',
    },
  },
  {
    id: '85d26b22-9952-44f6-8f01-028bd1ab0439',
    name: 'Leather Journal',
    category: 'Book',
    metadata: {
      description: 'For gratitude journaling and processing emotions.',
    },
  },
  {
    id: '14612701-9448-46af-842e-6b412d734e6e',
    name: 'Smart Indoor Garden',
    category: 'Appliance',
    brand: 'Click & Grow',
    metadata: {
      description: 'Allows her to grow fresh basil and mint in the kitchen year-round.',
    },
  },
];

// ==========================================
// EMMA SMITH (The Emerging Conscience)
// Context: 14yo, Artist, Writer, Activist, Feeler
// ==========================================
export const EMMA_ITEMS: SeedItem[] = [
  {
    id: '3cf3b18a-fde0-4798-9538-be06cc33f8b6',
    name: 'Digital Art Tablet',
    category: 'Digital Device',
    brand: 'Apple',
    metadata: {
      model: 'iPad Pro + Pencil',
      description: 'Used for creating digital art and writing poetry.',
    },
  },
  {
    id: 'cf0dc57c-7f16-4230-b8cc-7023113f20c3',
    name: 'Noise-Cancelling Headphones',
    category: 'Audio',
    brand: 'Sony',
    metadata: {
      model: 'WH-1000XM5',
      description: 'Essential for tuning out family chaos and listening to indie music.',
    },
  },
  {
    id: 'af85f187-9d2e-4113-a0b3-990e52ed4647',
    name: 'Vintage Vinyl Player',
    category: 'Audio',
    brand: 'Audio-Technica',
    metadata: {
      description: "A recent birthday gift to support her interest in 'real' music.",
    },
  },
  {
    id: '25d3a6be-5945-45fc-a24f-e993793507d0',
    name: 'Sketchbook Collection',
    category: 'Book',
    metadata: {
      description: 'Physical books filled with charcoal sketches and journal entries.',
    },
  },
  {
    id: '1bebe556-7f1d-4f3b-8a29-685ef5e9ce10',
    name: 'Smartphone',
    category: 'Digital Device',
    brand: 'Apple',
    metadata: {
      model: 'iPhone 14',
      description: 'Her connection to social causes and friends.',
    },
  },
  {
    id: '22fda38a-2886-46ad-bfdf-37a4000c0c7b',
    name: 'Acoustic Guitar',
    category: 'Musical Instrument',
    brand: 'Taylor',
    metadata: {
      model: 'GS Mini',
      description: 'Used for songwriting in her room.',
    },
  },
  {
    id: '16f8eb28-f6af-433e-a342-1bffb4a32188',
    name: 'Mirrorless Camera',
    category: 'Electronics',
    brand: 'Fujifilm',
    metadata: {
      model: 'X-T30',
      description: 'For documenting her art and protest marches.',
    },
  },
  {
    id: '5698d937-2e3a-4448-aec8-ac470c13018f',
    name: 'Sewing Machine',
    category: 'Appliance',
    brand: 'Singer',
    metadata: {
      description: 'Used for upcycling thrift store clothes (sustainability).',
    },
  },
  {
    id: '77e5a211-dd48-4a21-b4c8-f3aa53dd80b5',
    name: 'Canvas Backpack',
    category: 'Bag',
    brand: 'Fjallraven',
    metadata: {
      description: 'Covered in enamel pins supporting various social causes.',
    },
  },
  {
    id: '86adfa78-b66f-4293-90c4-a94612256df0',
    name: 'LED Strip Lights',
    category: 'Decor',
    metadata: {
      description: 'Lighting that changes color to match her current emotional state.',
    },
  },
];

// ==========================================
// LUCAS SMITH (The Spark of Joy)
// Context: 10yo, Soccer, Lego, Video Games, Doer
// ==========================================
export const LUCAS_ITEMS: SeedItem[] = [
  {
    id: '3628b078-796e-41e8-9b2d-eed719ff4aa8',
    name: 'Nintendo Switch',
    category: 'Gaming Console',
    brand: 'Nintendo',
    metadata: {
      model: 'OLED',
      description: 'The vessel for Mario Kart and Zelda.',
    },
  },
  {
    id: '1d713c7a-0f3e-456c-83aa-32015b6c0997',
    name: 'Soccer Ball & Cleats',
    category: 'Sports Equipment',
    brand: 'Adidas',
    metadata: {
      description: 'Well-worn gear. The ball is rarely not at his feet.',
    },
  },
  {
    id: '8e64dcaa-c093-4a44-9151-5b865c848e65',
    name: 'LEGO Collection',
    category: 'Toy',
    brand: 'LEGO',
    metadata: {
      description: 'Several large bins of mixed bricks and Star Wars sets.',
    },
  },
  {
    id: 'da8e07f0-6fad-42ad-8fe5-0566eebcb0a3',
    name: 'Mountain Bike',
    category: 'Vehicle',
    brand: 'Specialized',
    metadata: {
      size: '24 inch',
      description: 'For neighborhood races with Sam and Leo.',
    },
  },
  {
    id: '4ceb22b1-2d8f-403f-99c7-531bc575cbcf',
    name: 'Action Camera',
    category: 'Electronics',
    brand: 'GoPro',
    metadata: {
      description: "Used to film bike stunts and 'cool jumps'.",
    },
  },
  {
    id: '36da0a15-eb89-4c81-85a5-71d06625063e',
    name: 'VR Headset',
    category: 'Gaming Console',
    brand: 'Meta',
    metadata: {
      model: 'Quest 3',
      description: 'Shared with John, but mostly used by Lucas for Gorilla Tag.',
    },
  },
  {
    id: '50ddc072-3e3a-4381-abad-08a380991b89',
    name: 'Skateboard',
    category: 'Sports Equipment',
    brand: 'Element',
    metadata: {
      description: 'His secondary mode of transport for maximum kinetic energy.',
    },
  },
  {
    id: '62fb1d3d-9842-4f7e-8a98-0e17779ad9ab',
    name: 'Foam Dart Blaster',
    category: 'Toy',
    brand: 'Nerf',
    metadata: {
      description: 'Used for ambushing his father and sister.',
    },
  },
  {
    id: '9cfe7e58-4b2a-4a60-b8e9-6d9f6a55f3ca',
    name: 'iPad Mini',
    category: 'Digital Device',
    brand: 'Apple',
    metadata: {
      description: 'Used exclusively for Minecraft and watching YouTube stunt videos.',
    },
  },
  {
    id: '7d44ddcc-bac3-421a-a3ec-138adfe9d09c',
    name: 'Running Shoes',
    category: 'Clothing',
    brand: 'Nike',
    metadata: {
      description: 'Grass-stained and worn out from constant running.',
    },
  },
];

export const ITEMS: SeedItem[] = [...JOHN_ITEMS, ...SARAH_ITEMS, ...EMMA_ITEMS, ...LUCAS_ITEMS];
