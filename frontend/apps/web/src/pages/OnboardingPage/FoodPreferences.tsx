import burger from './assets/burger.jpg';
import pasta from './assets/pasta.jpg';
import salad from './assets/salad.jpg';
import tacos from './assets/tacos.jpg';
import { OptionGrid } from './OptionGrid';

const options = [
  {
    id: 'pasta',
    title: 'Pasta',
    imageUrl: pasta,
  },
  {
    id: 'burgers',
    title: 'Burgers',
    imageUrl: burger,
  },
  {
    id: 'salad',
    title: 'Salad',
    imageUrl: salad,
  },
  {
    id: 'tacos',
    title: 'Tacos',
    imageUrl: tacos,
  },
];

export function FoodPreferences() {
  return (
    <>
      <div className="text-center text-2xl mb-6 md:mb-10">Would you rather eat?</div>
      <OptionGrid options={options} />
    </>
  );
}
