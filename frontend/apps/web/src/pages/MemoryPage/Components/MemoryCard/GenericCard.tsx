import { Card, cn } from '@ci/shadcn';

import type { MemoryItem } from '../../types';
import { useMemoryService } from '../../useMemoryService';

interface Props {
  memory: MemoryItem;
  Icon: React.ComponentType<{ className?: string }>;
  iconColorClass: string;
}

export function GenericCard({ memory, Icon, iconColorClass }: Props) {
  const { setActiveMemory } = useMemoryService();

  const handleClick = () => {
    setActiveMemory(memory);
  };

  return (
    <Card
      className="!gap-2 !py-4 px-6 cursor-pointer hover:shadow-lg transition-shadow duration-200"
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        <Icon className={cn('h-6 w-6 flex-shrink-0 mt-1', iconColorClass)} />
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-card-foreground truncate">{memory.title}</h3>
          <p className="text-sm text-muted-foreground">{memory.category}</p>
        </div>
      </div>

      {memory.description && (
        <div className="pt-3 pb-3">
          <p className="text-sm text-muted-foreground leading-relaxed">{memory.description}</p>
        </div>
      )}

      {memory.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {memory.tags.map((tag, index) => (
            <span key={index} className="px-2 py-1 bg-muted text-muted-foreground text-xs rounded-full">
              {tag}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}
