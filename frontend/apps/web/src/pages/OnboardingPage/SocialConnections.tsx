import { useState } from 'react';

import { Input, Select, Button } from '@ci/shadcn';

function Person() {
  return (
    <>
      <Input className="w-full" placeholder="First" />
      <Input className="w-full" placeholder="Last" />
      <Select>
        <Select.Trigger className="w-24 overflow-hidden truncate min-w-0">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Group>
            <Select.Label>Family</Select.Label>
            <Select.Item value={'partner'}>Partner</Select.Item>
            <Select.Item value={'parent'}>Parent</Select.Item>
            <Select.Item value={'child'}>Child</Select.Item>
          </Select.Group>
          <Select.Group>
            <Select.Label>Social</Select.Label>
            <Select.Item value={'roommate'}>Roommate</Select.Item>
            <Select.Item value={'friend'}>Friend</Select.Item>
            <Select.Item value={'coworker'}>Co-worker</Select.Item>
          </Select.Group>
          <Select.Group>
            <Select.Label>Other</Select.Label>
            <Select.Item value={'complicated'}>It's complicated</Select.Item>
          </Select.Group>
        </Select.Content>
      </Select>
    </>
  );
}

export function SocialConnections() {
  const [count, setCount] = useState(3);

  return (
    <div className="space-y-4">
      <div className="text-center text-2xl mb-1">Folks you're usually around</div>
      <div className="text-center text-sm text-muted-foreground mb-4 md:mb-8">
        Let's start with up to 6 for now
      </div>

      <div className="grid grid-cols-[1fr_1fr_max-content] items-center gap-x-3 gap-y-3">
        {Array.from({ length: count }).map((_, i) => (
          <Person key={i} />
        ))}
      </div>

      <div className="text-center">
        {count < 6 && (
          <Button variant="secondary" onClick={() => setCount((current) => current + 1)}>
            Add another person
          </Button>
        )}
      </div>
    </div>
  );
}
