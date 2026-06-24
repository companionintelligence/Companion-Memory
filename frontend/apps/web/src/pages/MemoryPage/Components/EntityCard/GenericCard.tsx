import type { ComponentType, ReactNode } from 'react';

import { Card } from '@ci/shadcn';

import { Tag } from '@/components/Tag';

export interface Props {
  title: string;
  subtitle?: string;
  description?: string;
  preview?: ReactNode;
  tags?: string[];
  icon: ComponentType<{ className?: string }>;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export function GenericCard({ title, subtitle, description, preview, tags, icon: Icon, onClick }: Props) {
  return (
    <Card
      className="!gap-2 !px-6 !py-4 cursor-pointer transition-shadow duration-200 hover:shadow-lg"
      onClick={onClick}
    >
      {preview && <div className="mb-3 -mx-6 -mt-4">{preview}</div>}

      <div className="flex items-start gap-3">
        <Icon className="h-6 w-6 flex-shrink-0 mt-1" />
        <div className="flex-1 min-w-0">
          <h3 className="truncate text-lg font-semibold leading-4 text-card-foreground">{title}</h3>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>

      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-2">
          {tags.map((tag, index) => (
            <Tag key={index} text={tag} />
          ))}
        </div>
      )}

      {description && (
        <div className="pt-3 pb-3">
          <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
        </div>
      )}
    </Card>
  );
}
