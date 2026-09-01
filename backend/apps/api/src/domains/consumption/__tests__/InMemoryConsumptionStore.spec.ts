import { InMemoryConsumptionStore } from '../InMemoryConsumptionStore';

import { itBehavesLikeAConsumptionStore } from './consumptionStore.contract';

let counter = 0;

itBehavesLikeAConsumptionStore(
  'InMemoryConsumptionStore',
  () => new InMemoryConsumptionStore(),
  () => `k${++counter}`,
);
