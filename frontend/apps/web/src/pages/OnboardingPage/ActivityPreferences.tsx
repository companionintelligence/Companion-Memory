import arcade from './assets/arcade.jpg';
import bowling from './assets/bowling.jpg';
import hiking from './assets/hiking.jpg';
import skating from './assets/skating.jpg';
import { OptionGrid } from './OptionGrid';

const options = [
  {
    id: 'hiking',
    title: 'Hiking',
    imageUrl: hiking,
  },
  {
    id: 'bowling',
    title: 'Bowling',
    imageUrl: bowling,
  },
  {
    id: 'skating',
    title: 'Skating',
    imageUrl: skating,
  },
  {
    id: 'arcading',
    title: 'Arcading',
    imageUrl: arcade,
  },
];

export function ActivityPreferences() {
  return (
    <>
      <div className="text-center text-2xl mb-6 md:mb-10">Would you rather go?</div>
      <OptionGrid options={options} />
    </>
  );
}
