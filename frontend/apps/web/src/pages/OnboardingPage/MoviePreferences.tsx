import clown from './assets/clown.jpg';
import drama from './assets/drama.jpg';
import nature from './assets/nature.jpg';
import zombie from './assets/zombie.jpg';
import { OptionGrid } from './OptionGrid';

const options = [
  {
    id: 'drama',
    title: 'Dramas',
    imageUrl: drama,
  },
  {
    id: 'documentary',
    title: 'Documentaries',
    imageUrl: nature,
  },
  {
    id: 'comedy',
    title: 'Comedies',
    imageUrl: clown,
  },
  {
    id: 'horror',
    title: 'Horror',
    imageUrl: zombie,
  },
];

export function MoviePreferences() {
  return (
    <>
      <div className="text-center text-2xl mb-6 md:mb-10">Would you rather watch?</div>
      <OptionGrid options={options} />
    </>
  );
}
