import { type CreateConceptDto } from '@ci/domains/memory/types';

type SeedConcept = RequiredFields<Pick<CreateConceptDto, 'id' | 'name' | 'description' | 'properties'>, 'id'>;

export const MACHINE_LEARNING: SeedConcept = {
  id: '019b7de0-05cd-777d-878a-516c4cf60ea6',
  name: 'Machine Learning',
  description:
    'A field of artificial intelligence focused on building systems that learn from data to improve performance without explicit programming.',
  properties: {
    type: 'Technology',
  },
};

export const ENTREPRENEURSHIP: SeedConcept = {
  id: '019b7de0-05ce-714d-af2f-d339ebf22852',
  name: 'Entrepreneurship',
  description:
    'The process of designing, launching, and running a new business venture, often involving innovation and risk-taking.',
  properties: {
    type: 'Business',
  },
};

export const PHOTOGRAPHY: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0ae-e051cf000750',
  name: 'Photography',
  description:
    'The art and practice of creating durable images by recording light, either electronically or chemically.',
  properties: {
    type: 'Hobby',
  },
};

export const COOKING: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0ae-e7a64ef62346',
  name: 'Cooking',
  description: 'The art, science, and craft of using heat to prepare food for consumption.',
  properties: {
    type: 'Hobby',
  },
};

export const TRAVEL: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0ae-e8d40dad44da',
  name: 'Travel',
  description:
    'The movement of people between distant geographical locations for leisure, exploration, or business purposes.',
  properties: {
    type: 'Interest',
  },
};

export const FITNESS: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0ae-efb45dd1fe6b',
  name: 'Fitness',
  description:
    'The state of health and well-being and, more specifically, the ability to perform aspects of sports, occupations, and daily activities.',
  properties: {
    type: 'Health',
  },
};

export const MUSIC_PRODUCTION: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0ae-f2afae8c2885',
  name: 'Music Production',
  description:
    'The process of creating, capturing, manipulating, and preserving music using technology and artistic judgment.',
  properties: {
    type: 'Creative',
  },
};

export const SUSTAINABLE_LIVING: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0ae-f4b058cb5b2c',
  name: 'Sustainable Living',
  description:
    "A lifestyle that attempts to reduce an individual's or society's use of earth's natural resources and personal resources.",
  properties: {
    type: 'Lifestyle',
  },
};

export const PIZZA: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0ae-f83a08240d17',
  name: 'Pizza',
  description:
    'A savory dish of Italian origin consisting of a flattened base of leavened wheat-based dough topped with tomatoes, cheese, and various other ingredients.',
  properties: {
    type: 'Food',
    cuisine: 'Italian',
    common_variations: ['Margherita', 'Pepperoni', 'Hawaiian', 'BBQ Chicken'],
  },
};

export const SUSHI: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0ae-fdbfd4781572',
  name: 'Sushi',
  description:
    'A traditional Japanese dish of prepared vinegared rice accompanying a variety of ingredients such as seafood and vegetables.',
  properties: {
    type: 'Food',
    cuisine: 'Japanese',
    common_variations: ['Nigiri', 'Maki', 'Sashimi', 'Temaki'],
  },
};

export const TACOS: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-0180acb46529',
  name: 'Tacos',
  description:
    'A traditional Mexican dish consisting of a small hand-sized corn or wheat tortilla topped with a filling.',
  properties: {
    type: 'Food',
    cuisine: 'Mexican',
    common_variations: ['Carne Asada', 'Al Pastor', 'Fish', 'Vegetarian'],
  },
};

export const THAI_FOOD: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-07c3a07c1a84',
  name: 'Thai Food',
  description:
    'The national cuisine of Thailand, known for its balance of five fundamental flavors: hot, sour, sweet, salty, and bitter.',
  properties: {
    type: 'Cuisine',
    region: 'Southeast Asia',
    signature_dishes: ['Pad Thai', 'Green Curry', 'Tom Yum', 'Massaman Curry'],
  },
};

export const ITALIAN_CUISINE: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-0858f1768134',
  name: 'Italian Cuisine',
  description:
    'A Mediterranean cuisine consisting of the ingredients, recipes, and cooking techniques developed across the Italian Peninsula.',
  properties: {
    type: 'Cuisine',
    region: 'Southern Europe',
    signature_dishes: ['Pasta', 'Risotto', 'Osso Buco', 'Tiramisu'],
  },
};

export const BBQ: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-0c35f80f252b',
  name: 'BBQ',
  description:
    'A cooking method, a style of food, and a name for a meal or gathering at which this style of food is cooked and served.',
  properties: {
    type: 'Food',
    cuisine: 'American',
    regional_styles: ['Texas', 'Kansas City', 'Carolina', 'Memphis'],
  },
};

export const VEGETARIAN: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-1015f6a24261',
  name: 'Vegetarian',
  description:
    'A dietary lifestyle that excludes the consumption of meat and fish, focusing on plant-based foods.',
  properties: {
    type: 'Dietary preference',
    common_foods: ['Vegetables', 'Legumes', 'Grains', 'Tofu'],
  },
};

export const INDIAN_CUISINE: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-1450c34be8cc',
  name: 'Indian Cuisine',
  description:
    'The diverse cuisines of the Indian subcontinent, characterized by the extensive use of spices, herbs, vegetables, and fruit.',
  properties: {
    type: 'Cuisine',
    region: 'South Asia',
    signature_dishes: ['Curry', 'Biryani', 'Tandoori', 'Dosa'],
  },
};

export const MEXICAN_FOOD: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-18ffb16f7cbf',
  name: 'Mexican Food',
  description:
    'A cuisine known for its intense and varied flavors, colorful decoration, and variety of spices.',
  properties: {
    type: 'Cuisine',
    region: 'North America',
    signature_dishes: ['Tacos', 'Enchiladas', 'Mole', 'Tamales'],
  },
};

export const CHINESE_FOOD: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-1d69d862985a',
  name: 'Chinese Food',
  description:
    'The culinary tradition of China, which is inextricably linked to the history of the country and its diverse regions.',
  properties: {
    type: 'Cuisine',
    region: 'East Asia',
    regional_styles: ['Cantonese', 'Sichuan', 'Hunan', 'Shanghainese'],
  },
};

export const MEDITERRANEAN: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-21cf0d84ad4a',
  name: 'Mediterranean',
  description:
    'A diet and cuisine inspired by the eating habits of countries bordering the Mediterranean Sea.',
  properties: {
    type: 'Cuisine',
    region: 'Mediterranean',
    signature_dishes: ['Hummus', 'Falafel', 'Grilled Fish', 'Greek Salad'],
  },
};

export const SEAFOOD: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-264b599d6120',
  name: 'Seafood',
  description: 'Any form of sea life regarded as food by humans, prominently including fish and shellfish.',
  properties: {
    type: 'Food',
    common_types: ['Fish', 'Shrimp', 'Crab', 'Lobster', 'Oysters'],
  },
};

export const SCIFI: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-289a0c002ce7',
  name: 'Sci-Fi',
  description:
    'A film genre that uses speculative, fictional science-based depictions of phenomena that are not fully accepted by mainstream science.',
  properties: {
    type: 'Movie genre',
    themes: ['Space exploration', 'AI', 'Time travel', 'Dystopia'],
    example_films: ['Blade Runner', 'Interstellar', 'The Matrix'],
  },
};

export const ACTION: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-2cf8a7faeace',
  name: 'Action',
  description:
    'A film genre in which the protagonist is thrust into a series of events that typically include violence, extended fighting, and frenetic chases.',
  properties: {
    type: 'Movie genre',
    themes: ['Heroes', 'Combat', 'Chase sequences', 'Explosions'],
    example_films: ['Die Hard', 'Mad Max', 'John Wick'],
  },
};

export const COMEDY: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-31ca1fc8c78c',
  name: 'Comedy',
  description:
    'A genre of film in which the main emphasis is on humor, designed to make the audience laugh through amusement.',
  properties: {
    type: 'Movie genre',
    sub_genres: ['Romantic comedy', 'Dark comedy', 'Slapstick', 'Satire'],
    example_films: ['Airplane!', 'The Grand Budapest Hotel', 'Superbad'],
  },
};

export const DRAMA: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-364dee28df8c',
  name: 'Drama',
  description:
    'A film genre that depends mostly on in-depth development of realistic characters dealing with emotional themes.',
  properties: {
    type: 'Movie genre',
    themes: ['Relationships', 'Personal growth', 'Conflict', 'Social issues'],
    example_films: ['The Shawshank Redemption', "Schindler's List", 'Moonlight'],
  },
};

export const THRILLER: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-3ad5678fa71b',
  name: 'Thriller',
  description:
    'A film genre that creates a feeling of intense excitement, suspense, surprise, anticipation, and anxiety.',
  properties: {
    type: 'Movie genre',
    sub_genres: ['Psychological', 'Crime', 'Spy', 'Legal'],
    example_films: ['Se7en', 'Gone Girl', 'The Silence of the Lambs'],
  },
};

export const HORROR: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-3ec6ddaacfaa',
  name: 'Horror',
  description:
    'A film genre that seeks to elicit fear or disgust in its audience for entertainment purposes.',
  properties: {
    type: 'Movie genre',
    sub_genres: ['Slasher', 'Supernatural', 'Psychological', 'Gore'],
    example_films: ['The Exorcist', 'Get Out', 'Hereditary'],
  },
};

export const DOCUMENTARY: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-4156a7a619b5',
  name: 'Documentary',
  description:
    'A non-fictional motion-picture intended to document reality, primarily for purposes of instruction, education, or maintaining a historical record.',
  properties: {
    type: 'Movie genre',
    sub_genres: ['Nature', 'Biography', 'Historical', 'Social issues'],
    example_films: ['Planet Earth', "Won't You Be My Neighbor?", 'Free Solo'],
  },
};

export const ANIMATION: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-456bb3d55cf0',
  name: 'Animation',
  description:
    'A method in which figures are manipulated to appear as moving images, including traditional hand-drawn, stop-motion, and computer-generated styles.',
  properties: {
    type: 'Movie genre',
    techniques: ['2D', '3D CGI', 'Stop-motion', 'Anime'],
    example_films: ['Spirited Away', 'Toy Story', 'Spider-Verse'],
  },
};

export const ROMANCE: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-495e4113a12c',
  name: 'Romance',
  description:
    'A film genre that focuses on passion, emotion, and the affectionate romantic involvement of the main characters.',
  properties: {
    type: 'Movie genre',
    themes: ['Love stories', 'Heartbreak', 'Marriage', 'Dating'],
    example_films: ['The Notebook', 'Before Sunrise', 'Pride and Prejudice'],
  },
};

export const MYSTERY: SeedConcept = {
  id: '019b7de0-05cf-73dc-b0af-4d3a504d3e4f',
  name: 'Mystery',
  description:
    'A film genre that revolves around the solution of a problem or a crime, focusing on the efforts of a detective or amateur sleuth.',
  properties: {
    type: 'Movie genre',
    themes: ['Whodunit', 'Detective work', 'Clues', 'Twists'],
    example_films: ['Knives Out', 'The Usual Suspects', 'Chinatown'],
  },
};

export const ROCK: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-84acc26b9637',
  name: 'Rock',
  description:
    'A genre of popular music that originated as "rock and roll" in the United States in the 1950s.',
  properties: {
    type: 'Music genre',
    sub_genres: ['Classic Rock', 'Hard Rock', 'Alternative', 'Indie Rock'],
    origin: '1950s USA/UK',
    characteristics: ['Guitar-driven', 'Energetic', 'Rebellious'],
  },
};

export const JAZZ: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-894625b2a32c',
  name: 'Jazz',
  description:
    'A music genre that originated in the African-American communities of New Orleans in the late 19th and early 20th centuries.',
  properties: {
    type: 'Music genre',
    sub_genres: ['Bebop', 'Smooth Jazz', 'Fusion', 'Cool Jazz'],
    origin: 'Early 20th century New Orleans',
    characteristics: ['Improvisation', 'Swing', 'Complex chords'],
  },
};

export const CLASSICAL: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-8f702c427547',
  name: 'Classical',
  description:
    'Art music produced or rooted in the traditions of Western culture, including both liturgical and secular music.',
  properties: {
    type: 'Music genre',
    periods: ['Baroque', 'Classical', 'Romantic', 'Modern'],
    origin: 'Medieval Europe',
    characteristics: ['Orchestral', 'Complex compositions', 'Formal structure'],
  },
};

export const HIP_HOP: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-92ac09da74b7',
  name: 'Hip Hop',
  description:
    'A genre of popular music developed in the United States by inner-city African Americans and Latino Americans in the 1970s.',
  properties: {
    type: 'Music genre',
    sub_genres: ['Trap', 'Boom Bap', 'Conscious Rap', 'Mumble Rap'],
    origin: '1970s Bronx, New York',
    characteristics: ['Rapping', 'Sampling', 'Beats'],
  },
};

export const ELECTRONIC: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-973b52f29e95',
  name: 'Electronic',
  description:
    'Music that employs electronic musical instruments, digital instruments, and circuitry-based music technology.',
  properties: {
    type: 'Music genre',
    sub_genres: ['House', 'Techno', 'Dubstep', 'Ambient'],
    origin: '1970s-1980s',
    characteristics: ['Synthesizers', 'Digital production', 'Dance-oriented'],
  },
};

export const POP: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-98c506a6daa2',
  name: 'Pop',
  description:
    'A genre of popular music that originated in its modern form during the mid-1950s in the United States and the United Kingdom.',
  properties: {
    type: 'Music genre',
    sub_genres: ['Dance Pop', 'Teen Pop', 'Synth Pop', 'Indie Pop'],
    origin: '1950s',
    characteristics: ['Catchy melodies', 'Verse-chorus structure', 'Radio-friendly'],
  },
};

export const COUNTRY: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-9fbeb14ab8fa',
  name: 'Country',
  description:
    'A genre of popular music that originated with blues, old-time music, and various types of American folk music.',
  properties: {
    type: 'Music genre',
    sub_genres: ['Outlaw Country', 'Country Pop', 'Bluegrass', 'Honky Tonk'],
    origin: '1920s Southern USA',
    characteristics: ['Storytelling', 'Acoustic instruments', 'Twang'],
  },
};

export const RB: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-a170b9357fc7',
  name: 'R&B',
  description:
    'A genre of popular music that originated in African American communities in the 1940s, combining soul, funk, and pop elements.',
  properties: {
    type: 'Music genre',
    sub_genres: ['Contemporary R&B', 'Neo-Soul', 'Funk'],
    origin: '1940s African American communities',
    characteristics: ['Soulful vocals', 'Groove', 'Emotional'],
  },
};

export const INDIE: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-a4cf91dee967',
  name: 'Indie',
  description: 'Music produced independently from major commercial record labels or their subsidiaries.',
  properties: {
    type: 'Music genre',
    sub_genres: ['Indie Rock', 'Indie Folk', 'Indie Pop'],
    origin: '1970s-1980s',
    characteristics: ['DIY ethos', 'Experimental', 'Non-commercial'],
  },
};

export const METAL: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-a80dbf0ca68e',
  name: 'Metal',
  description:
    'A genre of rock music that developed in the late 1960s and early 1970s, largely in the United Kingdom and the United States.',
  properties: {
    type: 'Music genre',
    sub_genres: ['Heavy Metal', 'Thrash', 'Death Metal', 'Power Metal'],
    origin: 'Late 1960s-1970s',
    characteristics: ['Heavy distortion', 'Power', 'Technical skill'],
  },
};

export const HIKING: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-aeb4dd05cb55',
  name: 'Hiking',
  description:
    'An outdoor activity that involves walking in natural environments, often on hiking trails or footpaths.',
  properties: {
    type: 'activity',
    category: 'Outdoor/Fitness',
    benefits: ['Cardiovascular health', 'Mental clarity', 'Nature connection'],
    equipment: ['Hiking boots', 'Backpack', 'Water'],
  },
};

export const READING: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-b3569e77160f',
  name: 'Reading',
  description: 'The cognitive process of decoding symbols to derive meaning from written or printed text.',
  properties: {
    type: 'activity',
    category: 'Indoor/Educational',
    benefits: ['Knowledge', 'Vocabulary', 'Stress reduction'],
    formats: ['Books', 'E-readers', 'Audiobooks'],
  },
};

export const GAMING: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-b4a541b11674',
  name: 'Gaming',
  description:
    'The act of playing video games on various platforms including consoles, PCs, and mobile devices for entertainment.',
  properties: {
    type: 'activity',
    category: 'Indoor/Entertainment',
    benefits: ['Problem-solving', 'Hand-eye coordination', 'Social connection'],
    platforms: ['PC', 'Console', 'Mobile', 'VR'],
  },
};

export const SWIMMING: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-bbd045f9c1f6',
  name: 'Swimming',
  description:
    'The self-propulsion of a person through water, usually for recreation, sport, exercise, or survival.',
  properties: {
    type: 'activity',
    category: 'Fitness/Water Sport',
    benefits: ['Full-body workout', 'Low-impact', 'Flexibility'],
    styles: ['Freestyle', 'Backstroke', 'Breaststroke'],
  },
};

export const CYCLING: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-bded4ddc034b',
  name: 'Cycling',
  description: 'The use of bicycles for transport, recreation, exercise, or sport.',
  properties: {
    type: 'activity',
    category: 'Outdoor/Fitness',
    benefits: ['Cardiovascular health', 'Leg strength', 'Eco-friendly transport'],
    types: ['Road', 'Mountain', 'Commuting'],
  },
};

export const YOGA: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-c25997002d36',
  name: 'Yoga',
  description:
    'A group of physical, mental, and spiritual practices or disciplines which originated in ancient India.',
  properties: {
    type: 'activity',
    category: 'Fitness/Wellness',
    benefits: ['Flexibility', 'Stress reduction', 'Mind-body connection'],
    styles: ['Hatha', 'Vinyasa', 'Yin', 'Hot Yoga'],
  },
};

export const RUNNING: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-c51b53fe3413',
  name: 'Running',
  description:
    'A method of terrestrial locomotion allowing humans and other animals to move rapidly on foot.',
  properties: {
    type: 'activity',
    category: 'Outdoor/Fitness',
    benefits: ['Cardiovascular health', 'Endurance', 'Mental health'],
    types: ['Sprinting', 'Distance', 'Trail running'],
  },
};

export const PAINTING: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-ca45c843070f',
  name: 'Painting',
  description:
    'The practice of applying paint, pigment, color, or other medium to a solid surface to create visual art.',
  properties: {
    type: 'activity',
    category: 'Creative/Art',
    benefits: ['Creativity', 'Self-expression', 'Relaxation'],
    mediums: ['Oil', 'Acrylic', 'Watercolor', 'Digital'],
  },
};

export const WRITING: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-cd90ceb52d84',
  name: 'Writing',
  description:
    'The distinct human activity of creating meaning and communication through inscribed text and language.',
  properties: {
    type: 'activity',
    category: 'Creative/Educational',
    benefits: ['Self-expression', 'Communication skills', 'Mental clarity'],
    forms: ['Fiction', 'Poetry', 'Journalism', 'Blogging'],
  },
};

export const DANCING: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-d1f6e1787033',
  name: 'Dancing',
  description:
    'The performing art form consisting of purposefully selected sequences of human movement, often improvised or choreographed.',
  properties: {
    type: 'activity',
    category: 'Fitness/Creative',
    benefits: ['Cardiovascular health', 'Coordination', 'Social connection'],
    styles: ['Ballet', 'Hip Hop', 'Salsa', 'Contemporary'],
  },
};

export const COFFEE: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-d49dd7caa02d',
  name: 'Coffee',
  description:
    'A brewed drink prepared from roasted coffee beans, the seeds of berries from certain Coffea species.',
  properties: {
    type: 'beverage',
    category: 'Hot/Caffeinated',
    caffeine_content: 'High',
    varieties: ['Espresso', 'Americano', 'Latte', 'Cappuccino'],
    origin: 'Ethiopia',
  },
};

export const TEA: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-dbcfeee24f9f',
  name: 'Tea',
  description:
    'An aromatic beverage prepared by pouring hot or boiling water over cured or fresh leaves of Camellia sinensis.',
  properties: {
    type: 'beverage',
    category: 'Hot/Caffeinated',
    caffeine_content: 'Moderate',
    varieties: ['Green', 'Black', 'Oolong', 'White', 'Herbal'],
    origin: 'China',
  },
};

export const BEER: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-dfb785682646',
  name: 'Beer',
  description:
    'One of the oldest and most widely consumed alcoholic drinks in the world, and the third most popular drink overall.',
  properties: {
    type: 'beverage',
    category: 'Alcoholic',
    alcohol_content: 'Moderate (4-6%)',
    styles: ['Lager', 'IPA', 'Stout', 'Wheat', 'Pilsner'],
  },
};

export const WINE: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-e31397ad9a83',
  name: 'Wine',
  description:
    'An alcoholic drink made from fermented grape juice, utilizing various types of yeast to consume the sugar in the grapes.',
  properties: {
    type: 'beverage',
    category: 'Alcoholic',
    alcohol_content: 'Moderate-High (12-15%)',
    varieties: ['Red', 'White', 'Rosé', 'Sparkling'],
  },
};

export const COCKTAILS: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-e5127cd9f8aa',
  name: 'Cocktails',
  description:
    'An alcoholic mixed drink, which is either a combination of spirits, or one or more spirits mixed with other ingredients.',
  properties: {
    type: 'beverage',
    category: 'Alcoholic/Mixed',
    alcohol_content: 'Variable',
    classic_examples: ['Martini', 'Margarita', 'Old Fashioned', 'Mojito'],
  },
};

export const SMOOTHIES: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-e92c9618e459',
  name: 'Smoothies',
  description:
    'A thick, creamy beverage made from puréed raw fruit, vegetables, and sometimes dairy products.',
  properties: {
    type: 'beverage',
    category: 'Non-Alcoholic/Healthy',
    caffeine_content: 'None',
    common_ingredients: ['Fruits', 'Vegetables', 'Yogurt', 'Protein powder'],
  },
};

export const ESPRESSO: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-ed8917d5992f',
  name: 'Espresso',
  description:
    'A concentrated form of coffee brewed with high pressure, hot water, and finely ground coffee beans.',
  properties: {
    type: 'beverage',
    category: 'Hot/Caffeinated',
    caffeine_content: 'Very High',
    styles: ['Single', 'Double', 'Ristretto', 'Lungo'],
  },
};

export const KOMBUCHA: SeedConcept = {
  id: '019b7de0-05d0-7671-9725-f3d1ea99aff7',
  name: 'Kombucha',
  description:
    'A fermented, lightly effervescent, sweetened black or green tea drink commonly consumed for its supposed health benefits.',
  properties: {
    type: 'beverage',
    category: 'Fermented/Health',
    caffeine_content: 'Low',
    alcohol_content: 'Trace (<0.5%)',
    benefits: ['Probiotics', 'Antioxidants'],
  },
};

export const SOCCER: SeedConcept = {
  id: 'f723c981-8aba-4c49-b9ac-4f8eeedd2985',
  name: 'Soccer',
  description:
    'A team sport played with a spherical ball between two teams of 11 players, widely considered the most popular sport in the world.',
  properties: {
    type: 'sport',
    category: 'Team Sport',
  },
};

export const BASKETBALL: SeedConcept = {
  id: '0ee6fb86-a242-452d-85d2-d10f83edb02b',
  name: 'Basketball',
  description:
    "A team sport in which two teams compete with the primary objective of shooting a basketball through the defender's hoop.",
  properties: {
    type: 'sport',
    category: 'Team Sport',
  },
};

export const GOLF: SeedConcept = {
  id: '32a399da-cef0-4eb5-b64a-5ae5e7a4da15',
  name: 'Golf',
  description:
    'A club-and-ball sport in which players use various clubs to hit balls into a series of holes on a course in as few strokes as possible.',
  properties: {
    type: 'sport',
    category: 'Individual Sport',
  },
};

export const SKATEBOARDING: SeedConcept = {
  id: '1debdd6a-2f23-4acb-87d7-4d55ca1b07a0',
  name: 'Skateboarding',
  description:
    'An action sport that involves riding and performing tricks using a skateboard, as well as a recreational activity and art form.',
  properties: {
    type: 'sport',
    category: 'Action Sport',
  },
};

export const RUGBY: SeedConcept = {
  id: 'd2d5bc61-195b-4d51-b42e-5dfc1b621411',
  name: 'Rugby',
  description: 'A close-contact team sport that originated in England in the first half of the 19th century.',
  properties: {
    type: 'sport',
    category: 'Team Sport',
  },
};

export const LEGO: SeedConcept = {
  id: 'a3c76c89-2569-455b-a9b7-d0843814a95b',
  name: 'Lego',
  description:
    'A popular line of plastic construction toys that consists of colorful interlocking plastic bricks accompanying gears and figurines.',
  properties: {
    type: 'hobby',
    category: 'Creative/Construction',
  },
};

export const ROBOTICS: SeedConcept = {
  id: '56915a9f-dbb8-4373-9028-b36b18ecea61',
  name: 'Robotics',
  description:
    'The interdisciplinary branch of engineering and computer science involving the design, construction, and operation of robots.',
  properties: {
    type: 'interest',
    category: 'STEM',
  },
};

export const CHESS: SeedConcept = {
  id: '616bc256-7d0b-4b04-bee1-40105c06a506',
  name: 'Chess',
  description:
    'A two-player strategy board game played on a checkered board with 64 squares arranged in an 8x8 grid.',
  properties: {
    type: 'hobby',
    category: 'Strategy Game',
  },
};

export const BOARD_GAMES: SeedConcept = {
  id: '2e662be8-bb34-4bb9-87e5-ae90bcb9039e',
  name: 'Board Games',
  description:
    "Tabletop games that involve counters or pieces moved or placed on a pre-marked surface or 'board', according to a set of rules.",
  properties: {
    type: 'hobby',
    category: 'Social/Gaming',
  },
};

export const PUZZLES: SeedConcept = {
  id: 'd7aeddf2-714a-43d7-ba11-31ac514f6f1b',
  name: 'Puzzles',
  description:
    "Games, problems, or toys that test a person's ingenuity or knowledge, often requiring the assembly of pieces.",
  properties: {
    type: 'hobby',
    category: 'Mental/Logic',
  },
};

export const GARDENING: SeedConcept = {
  id: '108e10f3-23e6-47c3-89ca-a8f1ed4e8e50',
  name: 'Gardening',
  description:
    'The practice of growing and cultivating plants as part of horticulture, often for ornamental or consumption purposes.',
  properties: {
    type: 'hobby',
    category: 'Outdoor/Nature',
  },
};

export const BAKING: SeedConcept = {
  id: 'd5945632-3b69-43c6-9eb9-19c567b88380',
  name: 'Baking',
  description:
    'A method of preparing food that uses dry heat, normally in an oven, to cook doughs and batters.',
  properties: {
    type: 'hobby',
    category: 'Cooking/Culinary',
  },
};

export const CAMPING: SeedConcept = {
  id: '838c9665-783a-45f9-82c5-3db2a97439a9',
  name: 'Camping',
  description:
    'An outdoor activity involving overnight stays away from home, typically in a shelter such as a tent or a recreational vehicle.',
  properties: {
    type: 'activity',
    category: 'Outdoor',
  },
};

export const POTTERY: SeedConcept = {
  id: '58b9e6e9-bc67-480a-93c9-1554abfee47d',
  name: 'Pottery',
  description:
    'The craft of shaping clay into objects such as vessels and subjecting them to high temperatures to harden them.',
  properties: {
    type: 'hobby',
    category: 'Creative/Art',
  },
};

export const PSYCHOLOGY: SeedConcept = {
  id: '81a54cb3-4061-43ae-b5e1-397c3b111cb4',
  name: 'Psychology',
  description:
    'The scientific study of the mind and behavior, exploring concepts such as perception, cognition, attention, and emotion.',
  properties: {
    type: 'interest',
    category: 'Social Science',
  },
};

export const PHILOSOPHY: SeedConcept = {
  id: '57b91dd4-e478-4f5b-a690-6c99a3562758',
  name: 'Philosophy',
  description:
    'The systematic study of general and fundamental questions covering topics such as existence, reason, knowledge, values, and mind.',
  properties: {
    type: 'interest',
    category: 'Humanities',
  },
};

export const POLITICS: SeedConcept = {
  id: '8da17885-5892-40f3-9f53-1d8aae9c4c72',
  name: 'Politics',
  description:
    'The set of activities that are associated with making decisions in groups, or other forms of power relations between individuals.',
  properties: {
    type: 'interest',
    category: 'Social Science',
  },
};

export const ACTIVISM: SeedConcept = {
  id: '05307228-6903-4a9f-bb21-3b488e8bdc30',
  name: 'Activism',
  description:
    'The policy or action of using vigorous campaigning to bring about political or social change.',
  properties: {
    type: 'interest',
    category: 'Social/Political',
  },
};

export const DESIGN: SeedConcept = {
  id: '40b00da9-a205-4bfc-83df-c6aad0568781',
  name: 'Design',
  description:
    'The strategic process of creating plans or specifications for the construction of objects, systems, or interactions.',
  properties: {
    type: 'profession',
    category: 'Creative',
  },
};

export const ARCHITECTURE: SeedConcept = {
  id: 'e33c588c-81c8-4b20-ab18-8fc9565a9f26',
  name: 'Architecture',
  description:
    'The art and science of designing and constructing buildings and other physical structures that balance aesthetics and functionality.',
  properties: {
    type: 'profession',
    category: 'Creative/Technical',
  },
};

export const SOFTWARE_ENGINEERING: SeedConcept = {
  id: '2fdc7a2d-1961-42f3-a0b9-13cc71ebcae6',
  name: 'Software Engineering',
  description:
    'The systematic application of engineering principles to the design, development, testing, and maintenance of software systems.',
  properties: {
    type: 'profession',
    category: 'Technology',
  },
};

export const FASHION: SeedConcept = {
  id: 'df588e18-b2ab-4365-b404-5fff9a84086b',
  name: 'Fashion',
  description:
    'A form of self-expression and autonomy at a particular period and place, of clothing, footwear, lifestyle, and accessories.',
  properties: {
    type: 'interest',
    category: 'Creative/Lifestyle',
  },
};

export const SOCIAL_MEDIA: SeedConcept = {
  id: '67535c6f-cc67-4f10-b4af-8189cc9ae79b',
  name: 'Social Media',
  description:
    'Digital platforms that enable users to create and share content or participate in social networking.',
  properties: {
    type: 'interest',
    category: 'Technology/Communication',
  },
};

export const THEATER: SeedConcept = {
  id: 'fe4f017e-6832-4494-b26e-22b3ebe1c322',
  name: 'Theater',
  description:
    'A collaborative form of performing art that uses live performers to present the experience of a real or imagined event.',
  properties: {
    type: 'interest',
    category: 'Art/Performance',
  },
};

export const MEDITATION: SeedConcept = {
  id: 'ce0f747d-8215-4a0b-a5de-d520acc93d11',
  name: 'Meditation',
  description:
    'A practice where an individual uses a technique to train attention and awareness, and achieve a mentally clear and emotionally calm state.',
  properties: {
    type: 'activity',
    category: 'Wellness',
  },
};

export const VOLUNTEERING: SeedConcept = {
  id: '0f503946-1dbe-42a5-87b4-f16d258f02a6',
  name: 'Volunteering',
  description:
    'An altruistic activity where an individual or group provides services for no financial gain to benefit another person or organization.',
  properties: {
    type: 'activity',
    category: 'Community',
  },
};

export const CONCEPTS: SeedConcept[] = [
  MACHINE_LEARNING,
  ENTREPRENEURSHIP,
  PHOTOGRAPHY,
  COOKING,
  TRAVEL,
  FITNESS,
  MUSIC_PRODUCTION,
  SUSTAINABLE_LIVING,
  PIZZA,
  SUSHI,
  TACOS,
  THAI_FOOD,
  ITALIAN_CUISINE,
  BBQ,
  VEGETARIAN,
  INDIAN_CUISINE,
  MEXICAN_FOOD,
  CHINESE_FOOD,
  MEDITERRANEAN,
  SEAFOOD,
  SCIFI,
  ACTION,
  COMEDY,
  DRAMA,
  THRILLER,
  HORROR,
  DOCUMENTARY,
  ANIMATION,
  ROMANCE,
  MYSTERY,
  ROCK,
  JAZZ,
  CLASSICAL,
  HIP_HOP,
  ELECTRONIC,
  POP,
  COUNTRY,
  RB,
  INDIE,
  METAL,
  HIKING,
  READING,
  GAMING,
  SWIMMING,
  CYCLING,
  YOGA,
  RUNNING,
  PAINTING,
  WRITING,
  DANCING,
  COFFEE,
  TEA,
  BEER,
  WINE,
  COCKTAILS,
  SMOOTHIES,
  ESPRESSO,
  KOMBUCHA,
  SOCCER,
  BASKETBALL,
  GOLF,
  SKATEBOARDING,
  RUGBY,
  LEGO,
  ROBOTICS,
  CHESS,
  BOARD_GAMES,
  PUZZLES,
  GARDENING,
  BAKING,
  CAMPING,
  POTTERY,
  PSYCHOLOGY,
  PHILOSOPHY,
  POLITICS,
  ACTIVISM,
  DESIGN,
  ARCHITECTURE,
  SOFTWARE_ENGINEERING,
  FASHION,
  SOCIAL_MEDIA,
  THEATER,
  MEDITATION,
  VOLUNTEERING,
];
