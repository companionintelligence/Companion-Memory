import { useCallback, useState } from 'react';

type ReturnType = [
  {
    count: number;
  },
  { increment: () => void },
];

export function useCounter(): ReturnType {
  const [count, setCount] = useState<number>(0);

  const increment = useCallback(() => {
    setCount((prev) => prev + 1);
  }, []);

  return [
    {
      count,
    },
    {
      increment,
    },
  ];
}
